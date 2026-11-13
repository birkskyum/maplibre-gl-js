import {Color} from '@maplibre/maplibre-gl-style-spec';
import {drawTerrain, drawTerrainShade} from './draw/draw_terrain.ts';
import {drawHillshadeTable} from './draw/draw_hillshade.ts';
import {setFrameUniformWorldSize} from './frame_uniform_buffer.ts';
import {ImageSource} from '../source/image_source.ts';
import {RTT_DIFFERENCES, RTTFingerprint, type RTTDifference} from './rtt_fingerprint.ts';
import {isCustomStyleLayer} from '../style/style_layer/custom_style_layer.ts';
import {isHillshadeStyleLayer} from '../style/style_layer/hillshade_style_layer.ts';

import type {Tile} from '../tile/tile.ts';
import type {OverscaledTileID} from '../tile/tile_id.ts';
import type {Style} from '../style/style.ts';
import type {Terrain} from '../render/terrain.ts';
import type {Texture} from './texture.ts';
import type {StyleLayer} from '../style/style_layer.ts';
import type {Painter} from '../render/painter.ts';
import type {FrameRenderContext} from '../render/frame_render_context.ts';
import type {Framebuffer} from './framebuffer.ts';

/**
 * lookup table which layers should rendered to texture
 */
const LAYERS_TO_TEXTURES: { [keyof in StyleLayer['type']]?: boolean } = {
    background: true,
    fill: true,
    line: true,
    raster: true,
    hillshade: true,
    'color-relief': true
};

/**
 * Returns the key under which a tile keeps the fingerprint of the layer, which is the layer's source, or its id for a custom layer.
 */
function rttFingerprintKey(layer: StyleLayer): string | undefined {
    return isCustomStyleLayer(layer) ? `custom-layer:${layer.id}` : layer.source;
}

/**
 * Whether the layer is drawn into the terrain tiles' textures rather than onto the map: the layer types above, and
 * custom layers that implement `renderToTerrainTile`.
 */
function isRenderedToTexture(layer: StyleLayer): boolean {
    if (isCustomStyleLayer(layer)) return layer.implementation.renderToTerrainTile !== undefined;
    return LAYERS_TO_TEXTURES[layer.type] === true;
}

/**
 * A run of layers rendered into one texture per terrain tile. A hillshade lit from the viewport is a stack of its
 * own that holds its slopes, unlit: the terrain lights them when it is drawn, so no texture depends on the bearing.
 */
type RenderStack = {
    layerIds: string[];
    slopes: boolean;
};

/**
 * Returns the render stacks of the layers: a stack ends at a layer that is not rendered to texture, and before and
 * after a hillshade lit from the viewport.
 */
function getRenderStacks(style: Style, layerIds: string[]): RenderStack[] {
    const stacks: RenderStack[] = [];
    let open = false;
    for (const layerId of layerIds) {
        const layer = style._layers[layerId];
        if (!isRenderedToTexture(layer)) {
            open = false;
        } else if (isHillshadeStyleLayer(layer) && layer.isLitFromViewport()) {
            stacks.push({layerIds: [layerId], slopes: true});
            open = false;
        } else {
            if (!open) stacks.push({layerIds: [], slopes: false});
            stacks[stacks.length - 1].layerIds.push(layerId);
            open = true;
        }
    }
    return stacks;
}

/**
 * @internal
 * Renders RTT-eligible layers into per-tile cached textures, then drapes
 * them onto the terrain mesh. Slots live on each Tile so their lifetime
 * tracks the tile itself; the underlying FBO+texture handles are recycled
 * via the painter's RTT pool.
 */
export class RenderToTexture {
    painter: Painter;
    terrain: Terrain;
    /** RTT texture dimension in pixels (tile size × terrain quality factor). */
    rttSize: number;
    /**
     * coordsAscending contains a list of all tiles which should be rendered for one render-to-texture tile
     * e.g. render 4 raster-tiles with size 256px to the 512px render-to-texture tile
     */
    _coordsAscending: {[_: string]: {[_:string]: OverscaledTileID[]}};
    /**
     * This frame's fingerprint for each render-to-texture tile, keyed by source id
     * then tile key. A tile whose stored fingerprint differs has stale textures.
     */
    _rttFingerprints: Record<string, Record<string, RTTFingerprint>>;
    /**
     * store for render-stacks
     * a render stack is a set of layers which should be rendered into one texture
     * every stylesheet can have multiple stacks. A new stack is created if layers which should
     * not rendered to texture sit between layers which should rendered to texture. e.g. hillshading or symbols
     */
    _stacks: RenderStack[];
    /**
     * the stack the terrain is being drawn with
     */
    _currentStack: number;
    /**
     * the table of each hillshade layer that the terrain lights, by layer id
     */
    _hillshadeTables: Record<string, Framebuffer> = {};
    /**
     * a list of tiles that can potentially rendered
     */
    _renderableTiles: Tile[];
    /**
     * a list of tiles that should be rendered to screen in the next render-call
     */
    _rttTiles: Tile[];
    /**
     * a list of all layer-ids which should be rendered
     */
    _renderableLayerIds: string[];
    /**
     * the zoom of the previous prepareForRender call
     */
    _lastPrepareZoom: number;
    /**
     * whether the render loop needs a follow-up frame to refresh cached textures that were kept this frame:
     * textures rendered at another zoom, and stale textures beyond the per-frame budget.
     */
    needsFollowUpFrame: boolean = false;
    constructor(painter: Painter, terrain: Terrain) {
        this.painter = painter;
        this.terrain = terrain;
        this.rttSize = terrain.tileManager.tileSize * terrain.qualityFactor;
    }

    getTexture(tile: Tile): Texture {
        return tile.getRTT(this._currentStack).texture;
    }

    /**
     * Collects the frame's tiles, layers and source fingerprints and releases the textures that need
     * re-rendering. Textures that differ only by zoom are kept while the zoom is changing or the map is moving
     * and re-rendered one tile per frame once it has stopped, nearest to the camera first; textures with other
     * source tiles under them are re-rendered one per frame too, `needsFollowUpFrame` bringing in the rest.
     * Textures whose visible layer set changed (a layer entered or left its zoom range) are kept while the zoom
     * is changing and then all re-rendered in the same frame, since a tile-by-tile change would show; a source
     * data change re-renders immediately.
     */
    prepareForRender(style: Style, zoom: number, isMoving: boolean): void {
        const zoomChanged = zoom !== this._lastPrepareZoom;
        this._lastPrepareZoom = zoom;
        this._rttTiles = [];
        this._renderableTiles = this.terrain.tileManager.getRenderableTiles();
        this._renderableLayerIds = style._order.filter(id => !style._layers[id].isHidden(zoom));
        const stacks = this._stacks = getRenderStacks(style, this._renderableLayerIds);
        const visibleLayerIds = this._renderableLayerIds.join();

        const rttSourceIds = new Set<string>();
        for (const layerId of this._renderableLayerIds) {
            const layer = style._layers[layerId];
            const source = layer.source;
            if (source && LAYERS_TO_TEXTURES[layer.type]) rttSourceIds.add(source);
        }

        this._coordsAscending = {};
        this._rttFingerprints = {};
        for (const sourceId of rttSourceIds) {
            const tileManager = style.tileManagers[sourceId];
            if (!tileManager) continue;

            this._coordsAscending[sourceId] = {};
            const coordsAscending = this._coordsAscending[sourceId];
            const source = tileManager.getSource();
            const terrainTileRanges = source instanceof ImageSource ? source.terrainTileRanges : null;
            for (const tileID of tileManager.getVisibleCoordinates()) {
                const keys = this.terrain.tileManager.getTerrainCoords(tileID, terrainTileRanges);
                for (const key in keys) {
                    coordsAscending[key] ||= [];
                    coordsAscending[key].push(keys[key]);
                }
            }

            this._rttFingerprints[sourceId] = {};
            const fingerprints = this._rttFingerprints[sourceId];
            const revision = tileManager.getState().revision;
            for (const key in coordsAscending)
                fingerprints[key] = new RTTFingerprint(coordsAscending[key], revision, zoom, visibleLayerIds);
        }

        for (const layerId of this._renderableLayerIds) {
            const layer = style._layers[layerId];
            if (!isCustomStyleLayer(layer) || !isRenderedToTexture(layer)) continue;
            const revision = layer.implementation.terrainTileRevision ?? 0;
            const fingerprints: Record<string, RTTFingerprint> = {};
            for (const tile of this._renderableTiles) {
                fingerprints[tile.tileID.key] = new RTTFingerprint([tile.tileID], revision, zoom, visibleLayerIds);
            }
            this._rttFingerprints[rttFingerprintKey(layer)] = fingerprints;
        }

        // check tiles to render
        this.needsFollowUpFrame = false;
        const moving = zoomChanged || isMoving;
        let staleTileReleased = false;
        for (const tile of this._renderableTiles) {
            const difference = this._textureDifference(tile);
            if (difference === 'none') continue;
            if ((difference === 'zoom' && moving) || (difference === 'visibleLayers' && zoomChanged)) {
                this.needsFollowUpFrame = true;
            } else if (difference === 'zoom' || difference === 'sourceTiles') {
                if (staleTileReleased) this.needsFollowUpFrame = true;
                else this._releaseChangedTextures(tile, style, stacks);
                staleTileReleased = true;
            } else {
                this._releaseChangedTextures(tile, style, stacks);
            }
        }
    }

    /**
     * Releases the tile's textures of the stacks whose layers changed, or all of its textures when every stack
     * changed, which also drops the textures of stacks that the layers no longer form.
     */
    _releaseChangedTextures(tile: Tile, style: Style, stacks: RenderStack[]): void {
        const changedStacks = stacks.map(stack => this._hasStackChanged(tile, style, stack.layerIds));
        if (!changedStacks.includes(false)) {
            tile.releaseRTT(this.painter);
            return;
        }
        for (const [stack, changed] of changedStacks.entries()) {
            if (changed) tile.releaseRTTStack(this.painter, stack);
        }
    }

    /**
     * Whether the tile's texture of the stack differs from what this frame would render into it. A stack whose
     * layers have no fingerprint, background layers only, counts as changed.
     */
    _hasStackChanged(tile: Tile, style: Style, layerIds: string[]): boolean {
        let fingerprinted = false;
        for (const layerId of layerIds) {
            const fingerprintKey = rttFingerprintKey(style._layers[layerId]);
            const frameFingerprint = this._rttFingerprints[fingerprintKey]?.[tile.tileID.key];
            const tileFingerprint = tile.rttFingerprint[fingerprintKey];
            if (!frameFingerprint && !tileFingerprint) continue;
            if (frameFingerprint?.difference(tileFingerprint) !== 'none') return true;
            fingerprinted = true;
        }
        return !fingerprinted;
    }

    /**
     * The most severe difference, over the sources rendered to texture, between the tile's cached textures
     * and what this frame would render into them.
     */
    _textureDifference(tile: Tile): RTTDifference {
        let worst: RTTDifference = 'none';
        for (const source in this._rttFingerprints) {
            const frameFingerprint = this._rttFingerprints[source][tile.tileID.key];
            if (!frameFingerprint) continue;
            const difference = frameFingerprint.difference(tile.rttFingerprint[source]);
            if (RTT_DIFFERENCES.indexOf(difference) > RTT_DIFFERENCES.indexOf(worst)) worst = difference;
        }
        return worst;
    }

    /**
     * due that switching textures is relatively slow, the render
     * layer-by-layer context is not practicable. To bypass this problem
     * this lines of code stack all layers and later render all at once.
     * Because of the stylesheet possibility to mixing render-to-texture layers
     * and 'live'-layers (f.e. symbols) it is necessary to create more stacks. For example
     * a symbol-layer is in between of fill-layers.
     * @param layer - the layer to render
     * @param style - the style the stacked layers and their tile managers come from
     * @param frameRenderContext - shared state for the current render
     * @returns if true layer is rendered to texture, otherwise false
     */
    renderLayer(layer: StyleLayer, style: Style, frameRenderContext: FrameRenderContext): boolean {
        if (layer.isHidden(frameRenderContext.projectedCamera.zoom)) return false;
        if (!isRenderedToTexture(layer)) return false;

        const stackIndex = this._stacks.findIndex(stack => stack.layerIds.includes(layer.id));
        const stack = this._stacks[stackIndex];
        if (stack.layerIds[stack.layerIds.length - 1] !== layer.id) return true;

        const painter = this.painter;
        const size = stack.slopes ? this.rttSize / 2 : this.rttSize;
        frameRenderContext.isRenderingToTexture = true;
        setFrameUniformWorldSize(painter.context.frameUniformBuffer, size, size);
        for (const tile of this._renderableTiles) {
            this._rttTiles.push(tile);
            // Cache hit: this tile already has a RTT object for this stack from a previous frame.
            if (tile.getRTT(stackIndex)) continue;
            const obj = tile.acquireRTT(painter, stackIndex, size);
            painter.bindRTT(obj);
            painter.context.clear({color: Color.transparent, stencil: 0});
            frameRenderContext.invalidateTileClippingMasks();
            for (const layerId of stack.layerIds) {
                const stackLayer = style._layers[layerId];
                const coords = stackLayer.source ? this._coordsAscending[stackLayer.source][tile.tileID.key] : [tile.tileID];
                painter.context.viewport.set([0, 0, size, size]);
                frameRenderContext.renderTileClippingMasks(stackLayer, coords);
                painter.renderLayer(painter, style.tileManagers[stackLayer.source], stackLayer, coords, frameRenderContext);
                const fingerprintKey = rttFingerprintKey(stackLayer);
                if (fingerprintKey) tile.rttFingerprint[fingerprintKey] = this._rttFingerprints[fingerprintKey][tile.tileID.key];
            }
            obj.texture.generateMipmap();
        }
        frameRenderContext.isRenderingToTexture = false;
        setFrameUniformWorldSize(painter.context.frameUniformBuffer, painter.context.gl.drawingBufferWidth, painter.context.gl.drawingBufferHeight);
        this._currentStack = stackIndex;
        if (stack.slopes && isHillshadeStyleLayer(layer)) {
            const table = this._hillshadeTables[layer.id] = drawHillshadeTable(painter, layer, this._hillshadeTables[layer.id], frameRenderContext);
            drawTerrainShade(painter, this.terrain, this._rttTiles, table.colorAttachment.get(), frameRenderContext);
        } else {
            drawTerrain(painter, this.terrain, this._rttTiles, frameRenderContext);
        }
        this._rttTiles = [];
        return true;
    }

}
