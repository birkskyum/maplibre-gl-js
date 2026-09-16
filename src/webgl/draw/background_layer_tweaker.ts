import {backgroundUniformValues, backgroundPatternUniformValues} from '../program/background_program.ts';

import type {BackgroundUniformsType, BackgroundPatternUniformsType} from '../program/background_program.ts';
import type {BackgroundStyleLayer} from '../../style/style_layer/background_style_layer.ts';
import type {LayerTweaker} from '../layer_tweaker.ts';

/** The returned tweaker must run after all background patterns have been packed into the atlas. */
export function createBackgroundLayerTweaker(layer: BackgroundStyleLayer): LayerTweaker<BackgroundUniformsType | BackgroundPatternUniformsType> {
    return (drawables, painter, renderContext) => {
        const color = layer.paint.get('background-color');
        const opacity = layer.paint.get('background-opacity');
        const image = layer.paint.get('background-pattern');
        const crossfade = layer.getCrossfadeParameters();
        const tileSize = renderContext.transform.tileSize;
        const uniformValues = image ? null : backgroundUniformValues(opacity, color);
        const textures = image ? [{unit: 0, texture: painter.patternAtlas}] : [];

        for (const drawable of drawables.entries.values()) {
            drawable.uniformValues = image ?
                backgroundPatternUniformValues(opacity, painter, image, {tileID: drawable.tileID, tileSize}, crossfade) :
                uniformValues;
            drawable.textures = textures;
        }
    };
}
