import {StyleLayer} from '../style_layer.ts';
import properties, {type RasterPaintPropsPossiblyEvaluated} from './raster_style_layer_properties.g.ts';

import type {Transitionable, Transitioning, PossiblyEvaluated} from '../properties.ts';
import type {RasterPaintProps} from './raster_style_layer_properties.g.ts';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {PoleTextures} from '../../webgl/pole_textures.ts';

export const isRasterStyleLayer = (layer: StyleLayer): layer is RasterStyleLayer => layer.type === 'raster';

export class RasterStyleLayer extends StyleLayer {
    _transitionablePaint: Transitionable<RasterPaintProps>;
    _transitioningPaint: Transitioning<RasterPaintProps>;
    paint: PossiblyEvaluated<RasterPaintProps, RasterPaintPropsPossiblyEvaluated>;
    poleTextures: PoleTextures;

    constructor(layer: LayerSpecification, globalState: Record<string, any>) {
        super(layer, properties, globalState);
    }

    hasOffscreenPass(): boolean {
        return this.paint.get('raster-opacity') !== 0 && !this.isHidden();
    }
}
