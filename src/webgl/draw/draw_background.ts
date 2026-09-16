import {DepthMode} from '../depth_mode.ts';
import {CullFaceMode} from '../cull_face_mode.ts';
import {DrawableCollection} from '../drawable.ts';
import {createBackgroundLayerTweaker} from './background_layer_tweaker.ts';
import {coveringTiles} from '../../geo/projection/covering_tiles.ts';
import {isBackgroundStyleLayer} from '../../style/style_layer/background_style_layer.ts';

import type {RenderContext, RenderPass} from '../../render/render_context.ts';
import type {OverscaledTileID} from '../../tile/tile_id.ts';
import type {Painter} from '../../render/painter.ts';
import type {TileManager} from '../../tile/tile_manager.ts';
import type {BackgroundStyleLayer} from '../../style/style_layer/background_style_layer.ts';
import type {BackgroundUniformsType, BackgroundPatternUniformsType} from '../program/background_program.ts';

export type BackgroundDrawables = {
    layer: BackgroundStyleLayer;
    tiles: OverscaledTileID[];
    renderPass: RenderPass;
    drawables: DrawableCollection<BackgroundUniformsType | BackgroundPatternUniformsType>;
};

/**
 * Includes cached terrain tiles so their drawables are retained.
 * Background meshes have no borders or stencil clipping, so tiles within each target must not overlap.
 * Adding borders to cover tile-edge gaps also requires tile clipping masks and stencil clipping.
 */
export function prepareBackgroundDrawables(painter: Painter): void {
    const {context, transform, style, renderContext, backgroundDrawables} = painter;
    let tiles: OverscaledTileID[];

    for (let i = 0; i < style._order.length; i++) {
        const layer = style._layers[style._order[i]];
        if (!isBackgroundStyleLayer(layer) || layer.isHidden(transform.zoom)) continue;

        const color = layer.paint.get('background-color');
        const opacity = layer.paint.get('background-opacity');
        const image = layer.paint.get('background-pattern');
        if (opacity === 0 || painter.isPatternMissing(image)) continue;

        tiles ??= painter.renderToTexture ?
            renderContext.terrain.tileManager.getRenderableTiles().map(tile => tile.tileID) :
            coveringTiles(transform, {tileSize: transform.tileSize, terrain: renderContext.terrain});

        let group = backgroundDrawables.get(layer.id);
        if (group?.layer !== layer) {
            group = {layer, tiles, renderPass: 'translucent', drawables: new DrawableCollection(createBackgroundLayerTweaker(layer))};
            backgroundDrawables.set(layer.id, group);
        }
        group.tiles = tiles;
        group.renderPass = !image && color.a === 1 && opacity === 1 && i < renderContext.opaquePassCutoff ? 'opaque' : 'translucent';
        const program = painter.useProgram(image ? 'backgroundPattern' : 'background');

        for (const tileID of tiles) {
            const mesh = style.projection.getMeshFromTileID(context, tileID.canonical, false, true, 'raster');
            const drawable = group.drawables.get(tileID.key, program, mesh, layer.id, context.gl.TRIANGLES);
            drawable.tileID = tileID;
            drawable.renderPass = group.renderPass;
            drawable.depthMask = group.renderPass === 'opaque' ? DepthMode.ReadWrite : DepthMode.ReadOnly;
            drawable.cullFaceMode = CullFaceMode.backCCW;
        }
    }

    for (const [layerID, group] of backgroundDrawables) {
        group.drawables.endUpdate();
        if (!group.drawables.entries.size) {
            backgroundDrawables.delete(layerID);
            continue;
        }
        group.drawables.update(painter, renderContext);
    }
}

export function drawBackground(painter: Painter, tileManager: TileManager, layer: BackgroundStyleLayer, coords: OverscaledTileID[], renderContext: RenderContext): void {
    const group = painter.backgroundDrawables.get(layer.id);
    if (group?.renderPass !== renderContext.currentPass) return;

    for (const tileID of coords ?? group.tiles) {
        group.drawables.entries.get(tileID.key).draw(painter, renderContext);
    }
}
