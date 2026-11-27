import {transformText} from '../../symbol/transform_text.ts';
import {mergeLines} from '../../symbol/merge_lines.ts';
import {isCluster} from '../../util/graphemes.ts';
import {TaggedString} from '../../symbol/tagged_string.ts';
import {allowsLetterSpacing, allowsVerticalWritingMode, stringContainsRTLText} from '../../util/script_detection.ts';
import {mayUseVerticalGlyph} from '../../symbol/shaping.ts';
import {WritingMode} from '../../symbol/writing_mode.ts';
import {loadGeometry} from '../load_geometry.ts';
import {toEvaluationFeature} from '../evaluation_feature.ts';
import {VectorTileFeature} from '@mapbox/vector-tile';
import {verticalizedCharacterMap} from '../../util/verticalize_punctuation.ts';
import {performSymbolLayout} from '../../symbol/symbol_layout.ts';
import {isOutsideTile} from '../extent_bounds.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {Formatted, ResolvedImage} from '@maplibre/maplibre-gl-style-spec';

import type Point from '@mapbox/point-geometry';
import type {CanonicalTileID} from '../../tile/tile_id.ts';
import type {
    BucketBuilder,
    BucketDependencyParameters,
    IndexedFeature,
    PopulateParameters
} from '../bucket.ts';
import type {SymbolBucket, SymbolFeature} from './symbol_bucket.ts';

function containsRTLText(formattedText: Formatted): boolean {
    for (const section of formattedText.sections) {
        if (stringContainsRTLText(section.text)) {
            return true;
        }
    }
    return false;
}

function containsCursiveText(formattedText: Formatted): boolean {
    return formattedText.sections.some(section => !allowsLetterSpacing(section.text));
}

/**
 * @internal
 * Builds a {@link SymbolBucket} on the worker, see the steps listed there.
 */
export class SymbolBucketBuilder implements BucketBuilder {
    readonly bucket: SymbolBucket;
    hasDependencies: boolean;

    constructor(bucket: SymbolBucket) {
        this.bucket = bucket;
        this.hasDependencies = true;
    }

    /**
     * Collects a label's default and vertical glyph dependencies into `stacks` for the tile to request.
     *
     * A cluster of several codepoints is asked for as a whole, so that it can be drawn as the one
     * shape it is written as. Its codepoints are asked for as well, to give layout something to draw
     * a codepoint at a time where the cluster itself yields no glyph. See `shapeLines`.
     *
     * A cluster can span two sections, a letter in one and the accent written on it in the next, so
     * the label is taken as a whole and each cluster attributed to the section its first character
     * came from -- the same way layout attributes it. Collecting each section's text on its own
     * would ask for glyphs no cluster is ever looked up by.
     *
     * @param text - label text and section formatting
     * @param stacks - destination for dependencies grouped by font stack and variant
     * @param fontStack - default font stack for sections without a font override
     * @param needsVerticalForms - whether to request vertical alternates and compatibility punctuation
     */
    private calculateGlyphDependencies(
        text: Formatted,
        stacks: PopulateParameters['glyphDependencies'],
        fontStack: string,
        needsVerticalForms: boolean): void {

        const tagged = TaggedString.fromFeature(text, fontStack, false);
        const graphemes = tagged.graphemes();

        for (let i = 0; i < graphemes.length; i++) {
            const section = tagged.getSection(i);
            if ('imageName' in section) continue;

            stacks[section.fontStack] ||= {default: {}, vertical: {}};
            const stack = stacks[section.fontStack];
            const grapheme = graphemes[i];
            const needsVerticalGlyph = needsVerticalForms && mayUseVerticalGlyph(grapheme.codePointAt(0), this.bucket.allowVerticalPlacement);
            if (isCluster(grapheme)) stack.default[grapheme] = true;
            if (needsVerticalGlyph) stack.vertical[grapheme] = true;

            for (const char of grapheme) {
                stack.default[char] = true;
                if (!needsVerticalForms) continue;

                if (needsVerticalGlyph && isCluster(grapheme)) stack.vertical[char] = true;
                const verticalChar = verticalizedCharacterMap[char];
                if (verticalChar) stack.default[verticalChar] = true;
            }
        }
    }

    populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
        const layer = this.bucket.layers[0];
        const layout = layer.layout;

        const textFont = layout.get('text-font');
        const textField = layout.get('text-field');
        const iconImage = layout.get('icon-image');
        const hasText =
            (textField.value.kind !== 'constant' ||
                (textField.value.value instanceof Formatted && !textField.value.value.isEmpty()) ||
                textField.value.value.toString().length > 0) &&
            (textFont.value.kind !== 'constant' || textFont.value.value.length > 0);
        // we should always resolve the icon-image value if the property was defined in the style
        // this allows us to fire the styleimagemissing event if image evaluation returns null
        // the only way to distinguish between null returned from a coalesce statement with no valid images
        // and null returned because icon-image wasn't defined is to check whether or not iconImage.parameters is an empty object
        const hasIcon = iconImage.value.kind !== 'constant' || !!iconImage.value.value || Object.keys(iconImage.parameters).length > 0;
        const symbolSortKey = layout.get('symbol-sort-key');
        const pointPlacement = layout.get('symbol-placement') === 'point';

        this.bucket.features = [];

        if (!hasText && !hasIcon) {
            return;
        }

        const icons = options.iconDependencies;
        const stacks = options.glyphDependencies;
        const availableImages = options.availableImages;
        const globalProperties = new EvaluationParameters(this.bucket.zoom);
        const keepUpright = layout.get('text-keep-upright');

        for (const {feature, id, index, sourceLayerIndex} of features) {

            const needGeometry = layer._featureFilter.needGeometry;
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);
            if (!layer._featureFilter.filter(globalProperties, evaluationFeature, canonical)) {
                continue;
            }

            if (!needGeometry)  evaluationFeature.geometry = loadGeometry(feature);

            if (pointPlacement && feature.type === 1 && isEveryPointOutsideTile(evaluationFeature.geometry)) continue;

            let text: Formatted | void;
            if (hasText) {
                // Expression evaluation will automatically coerce to Formatted
                // but plain string token evaluation skips that pathway so do the
                // conversion here.
                const resolvedTokens = layer.getValueAndResolveTokens('text-field', evaluationFeature, canonical, availableImages);
                const formattedText = Formatted.factory(resolvedTokens);

                this.bucket.hasRTLText ||= containsRTLText(formattedText);
                this.bucket.hasCursiveText ||= containsCursiveText(formattedText);
                text = transformText(formattedText, layer, evaluationFeature);
            }

            let icon: ResolvedImage;
            if (hasIcon) {
                // Expression evaluation will automatically coerce to Image
                // but plain string token evaluation skips that pathway so do the
                // conversion here.
                const resolvedTokens = layer.getValueAndResolveTokens('icon-image', evaluationFeature, canonical, availableImages);
                if (resolvedTokens instanceof ResolvedImage) {
                    icon = resolvedTokens;
                } else {
                    icon = ResolvedImage.fromString(resolvedTokens);
                }
            }

            if (!text && !icon) {
                continue;
            }
            const sortKey = this.bucket.sortFeaturesByKey ?
                symbolSortKey.evaluate(evaluationFeature, {}, canonical) :
                undefined;

            const symbolFeature: SymbolFeature = {
                id,
                text,
                icon,
                index,
                sourceLayerIndex,
                geometry: evaluationFeature.geometry,
                properties: feature.properties,
                type: VectorTileFeature.types[feature.type],
                sortKey
            };
            this.bucket.features.push(symbolFeature);

            if (icon) {
                icons[icon.name] = true;
            }

            if (text) {
                const fontStack = textFont.evaluate(evaluationFeature, {}, canonical).join(',');
                const textAlongLine = layout.get('text-rotation-alignment') !== 'viewport' && layout.get('symbol-placement') !== 'point';
                this.bucket.allowVerticalPlacement = this.bucket.writingModes?.includes(WritingMode.vertical);
                const needsVerticalForms = ((textAlongLine && keepUpright) || this.bucket.allowVerticalPlacement) &&
                    allowsVerticalWritingMode(text.toString());
                this.calculateGlyphDependencies(text, stacks, fontStack, needsVerticalForms);

                for (const section of text.sections) {
                    if (section.image) icons[section.image.name] = true;
                }
            }
        }

        if (layout.get('symbol-placement') === 'line') {
            // Merge adjacent lines with the same text to improve labeling.
            // It's better to place labels on one long line than on many short segments.
            this.bucket.features = mergeLines(this.bucket.features);
        }

        if (this.bucket.sortFeaturesByKey) {
            this.bucket.features.sort((a, b) => {
                // a.sortKey is always a number when sortFeaturesByKey is true
                return (a.sortKey as number) - (b.sortKey as number);
            });
        }
    }

    addFeatures({options, canonical, glyphMap, glyphPositions, iconMap, iconPositions, showCollisionBoxes}: BucketDependencyParameters): void {
        performSymbolLayout({
            bucket: this.bucket,
            glyphMap,
            glyphPositions,
            imageMap: iconMap,
            imagePositions: iconPositions,
            showCollisionBoxes,
            canonical,
            subdivisionGranularity: options.subdivisionGranularity,
            hasPromoteId: options.featureIndex.promoteId != null
        });
    }
}

/**
 * Whether every point lies outside the tile. A point label is anchored on the point itself, and
 * `addSymbolAtAnchor` in symbol_layout.ts drops an anchor outside the tile, so such a feature gets no label here.
 */
function isEveryPointOutsideTile(geometry: Point[][]): boolean {
    return geometry.every(ring => ring.every(isOutsideTile));
}
