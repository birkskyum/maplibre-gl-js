import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {hasPattern, addPatternDependencies} from './pattern_bucket_features.ts';
import {loadGeometry} from '../load_geometry.ts';
import {toEvaluationFeature} from '../evaluation_feature.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {subdividePolygon} from '../../render/subdivision.ts';
import {fillLargeMeshArrays} from '../../render/fill_large_mesh_arrays.ts';
import {warnOnce} from '../../util/util.ts';

import type {CanonicalTileID} from '../../tile/tile_id.ts';
import type {
    BucketBuilder,
    BucketFeature,
    BucketDependencyParameters,
    IndexedFeature,
    PopulateParameters
} from '../bucket.ts';
import type Point from '@mapbox/point-geometry';
import type {ImagePosition} from '../../render/image_atlas.ts';
import type {SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';
import type {GetImagesResponse} from '../../util/actor_messages.ts';
import type {StyleImage} from '../../style/style_image.ts';
import type {FillBucket} from './fill_bucket.ts';

const EARCUT_MAX_RINGS = 500;

/**
 * @internal
 * Builds a {@link FillBucket} on the worker.
 */
export class FillBucketBuilder implements BucketBuilder {
    readonly bucket: FillBucket;
    hasDependencies: boolean;
    patternFeatures: BucketFeature[];

    constructor(bucket: FillBucket) {
        this.bucket = bucket;
        this.hasDependencies = false;
        this.patternFeatures = [];
    }

    populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
        this.hasDependencies = hasPattern('fill', this.bucket.layers, options);
        const fillSortKey = this.bucket.layers[0].layout.get('fill-sort-key');
        const sortFeaturesByKey = !fillSortKey.isConstant();
        const bucketFeatures: BucketFeature[] = [];

        const globalProperties = new EvaluationParameters(this.bucket.zoom);
        const needGeometry = this.bucket.layers[0]._featureFilter.needGeometry;
        for (const {feature, id, index, sourceLayerIndex} of features) {
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);

            if (!this.bucket.layers[0]._featureFilter.filter(globalProperties, evaluationFeature, canonical)) continue;

            const sortKey = sortFeaturesByKey ?
                fillSortKey.evaluate(evaluationFeature, {}, canonical, options.availableImages) :
                undefined;

            const bucketFeature: BucketFeature = {
                id,
                properties: feature.properties,
                type: feature.type,
                sourceLayerIndex,
                index,
                geometry: needGeometry ? evaluationFeature.geometry : loadGeometry(feature),
                patterns: {},
                sortKey
            };

            bucketFeatures.push(bucketFeature);
        }

        if (sortFeaturesByKey) {
            bucketFeatures.sort((a, b) => a.sortKey - b.sortKey);
        }

        for (const bucketFeature of bucketFeatures) {
            const {geometry, index, sourceLayerIndex} = bucketFeature;

            if (this.hasDependencies) {
                const patternFeature = addPatternDependencies('fill', this.bucket.layers, bucketFeature, {zoom: this.bucket.zoom}, options);
                // pattern features are added only once the pattern is loaded into the image atlas
                // so are stored during populate until later updated with positions by tile worker in addFeatures
                this.patternFeatures.push(patternFeature);
            } else {
                this.addFeature(bucketFeature, geometry, index, canonical, {}, options.subdivisionGranularity);
            }

            const feature = features[index].feature;
            options.featureIndex.insert(feature, geometry, index, sourceLayerIndex, this.bucket.index);
        }
    }

    addFeatures({options, canonical, patternPositions, patternMap}: BucketDependencyParameters): void {
        this.detectSdfPatterns(patternMap);
        for (const feature of this.patternFeatures) {
            this.addFeature(feature, feature.geometry, feature.index, canonical, patternPositions, options.subdivisionGranularity);
        }
    }

    private detectSdfPatterns(imageMap: GetImagesResponse): void {
        for (const feature of this.patternFeatures) {
            for (const layerId in feature.patterns) {
                const pattern = feature.patterns[layerId];
                this.recordSdfPattern(layerId, imageMap[pattern.min]);
                this.recordSdfPattern(layerId, imageMap[pattern.mid]);
                this.recordSdfPattern(layerId, imageMap[pattern.max]);
            }
        }

        for (const layer of this.bucket.layers) {
            const pattern = layer.paint.get('fill-pattern').constantOr(null);
            if (pattern) {
                this.recordSdfPattern(layer.id, imageMap[pattern.from.toString()]);
                this.recordSdfPattern(layer.id, imageMap[pattern.to.toString()]);
            }
        }
    }

    private recordSdfPattern(layerId: string, image: StyleImage | undefined): void {
        if (!image) return;

        const isSdf = image.sdf === true;
        const existing = this.bucket.sdfPatterns[layerId];
        if (existing === undefined) {
            this.bucket.sdfPatterns[layerId] = isSdf;
        } else if (existing !== isSdf) {
            warnOnce(`Style sheet warning: Cannot mix SDF and non-SDF fill patterns in layer "${layerId}"`);
        }
    }

    addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID, imagePositions: {
        [_: string]: ImagePosition;
    }, subdivisionGranularity: SubdivisionGranularitySetting): void {
        for (const polygon of classifyRings(geometry, EARCUT_MAX_RINGS)) {
            const subdivided = subdividePolygon(polygon, canonical, subdivisionGranularity.fill.getGranularityForZoomLevel(canonical.z));

            const vertexArray = this.bucket.layoutVertexArray;

            fillLargeMeshArrays(
                (x, y) => {
                    vertexArray.emplaceBack(x, y);
                },
                this.bucket.segments,
                this.bucket.layoutVertexArray,
                this.bucket.indexArray,
                subdivided.verticesFlattened,
                subdivided.indicesTriangles,
                this.bucket.segments2,
                this.bucket.indexArray2,
                subdivided.indicesLineList,
            );
        }
        this.bucket.programConfigurations.populatePaintArrays(this.bucket.layoutVertexArray.length, feature, index, {imagePositions, canonical});
    }
}
