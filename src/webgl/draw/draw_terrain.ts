import {StencilMode} from '../stencil_mode.ts';
import {DepthMode} from '../depth_mode.ts';
import {terrainUniformValues, terrainDepthUniformValues, terrainHeightUniformValues} from '../program/terrain_program.ts';
import {CullFaceMode} from '../cull_face_mode.ts';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {ColorMode} from '../color_mode.ts';
import {EXTENT} from '../../data/extent.ts';

import type {FrameRenderContext} from '../../render/frame_render_context.ts';
import type {Terrain, TerrainHeightMapTarget} from '../../render/terrain.ts';
import type {Tile} from '../../tile/tile.ts';
import type {OverscaledTileID} from '../../tile/tile_id.ts';
import type {Painter} from '../../render/painter.ts';

/** The offsets, in tiles, of the eight tiles around a tile. */
const NEIGHBOR_OFFSETS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * Redraw the Depth Framebuffer
 * @param painter - the painter
 * @param terrain - the terrain
 * @param frameRenderContext - shared state for the current render
 */
function drawDepth(painter: Painter, terrain: Terrain, frameRenderContext: FrameRenderContext): void {
    const context = frameRenderContext.context;
    const gl = context.gl;
    const tr = frameRenderContext.transform;
    const colorMode = ColorMode.unblended;
    const depthMode = new DepthMode(gl.LEQUAL, DepthMode.ReadWrite, [0, 1]);
    const tiles = terrain.tileManager.getRenderableTiles();
    const program = frameRenderContext.useProgram('terrainDepth');
    context.bindFramebuffer.set(terrain.getFramebuffer().framebuffer);
    context.viewport.set([0, 0, painter.width  / devicePixelRatio, painter.height / devicePixelRatio]);
    context.clear({color: Color.white, depth: 1});
    for (const tile of tiles) {
        const mesh = terrain.getTerrainMesh(tile.tileID, frameRenderContext.data.isRenderingGlobe);
        const terrainData = terrain.getTerrainData(tile.tileID);
        const projectionData = tr.getProjectionData({overscaledTileID: tile.tileID, applyTerrainMatrix: false, applyGlobeMatrix: true});
        const uniformValues = terrainDepthUniformValues(terrain.getSkirtLength(tr.zoom));
        program.draw(context, gl.TRIANGLES, depthMode, StencilMode.disabled, colorMode, CullFaceMode.backCCW, uniformValues, terrainData, projectionData, 'terrain', mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
    context.bindFramebuffer.set(null);
    context.viewport.set([0, 0, painter.width, painter.height]);
}

function drawTerrain(painter: Painter, terrain: Terrain, tiles: Tile[], frameRenderContext: FrameRenderContext): void {
    const {isRenderingGlobe} = frameRenderContext.data;
    const context = frameRenderContext.context;
    const gl = context.gl;
    const tr = frameRenderContext.transform;
    const colorMode = frameRenderContext.colorModeForRenderPass();
    const depthMode = frameRenderContext.getDepthModeFor3D();
    const program = frameRenderContext.useProgram('terrain');

    context.bindFramebuffer.set(null);
    context.viewport.set([0, 0, painter.width, painter.height]);

    for (const tile of tiles) {
        const mesh = terrain.getTerrainMesh(tile.tileID, isRenderingGlobe);
        const texture = painter.renderToTexture.getTexture(tile);
        const terrainData = terrain.getTerrainData(tile.tileID);
        context.activeTexture.set(gl.TEXTURE0);
        texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE, gl.LINEAR_MIPMAP_LINEAR);
        const eleDelta = terrain.getSkirtLength(tr.zoom);
        const fogMatrix = tr.calculateFogMatrix(tile.tileID.toUnwrapped());
        const uniformValues = terrainUniformValues(eleDelta, fogMatrix, frameRenderContext.data.sky, tr.pitch, isRenderingGlobe);
        const projectionData = frameRenderContext.getProjectionDataForTile(tile.tileID, {applyTerrainMatrix: false});
        program.draw(context, gl.TRIANGLES, depthMode, StencilMode.disabled, colorMode, CullFaceMode.backCCW, uniformValues, terrainData, projectionData, 'terrain', mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
}

/**
 * Draws the elevation of the loaded renderable terrain tiles into a texture, see {@link CustomRenderMethodInput.renderTerrainHeightMap},
 * over that of the tiles around them, so that objects whose anchor lies just outside the rendered tiles still stand on the ground.
 */
function drawTerrainHeightMap(frameRenderContext: FrameRenderContext, terrain: Terrain, target: TerrainHeightMapTarget): void {
    const context = frameRenderContext.context;
    const gl = context.gl;
    const [minX, minY, maxX, maxY] = target.bounds;
    context.setDirty();
    const framebuffer = terrain.getHeightMapFramebuffer(target.texture);
    context.viewport.set([0, 0, target.width, target.height]);
    context.clear({color: Color.transparent});

    const program = frameRenderContext.useProgram('terrainHeight', null, true);
    const renderableTiles = terrain.tileManager.getRenderableTiles();
    const tileIDs = [...getTileIDsAround(renderableTiles), ...renderableTiles.map(tile => tile.tileID)];
    for (const tileID of tileIDs) {
        const terrainData = terrain.getTerrainData(tileID);
        if (!terrainData.tile?.dem) continue;
        const {canonical, wrap} = tileID;
        const tileSize = 1 / (1 << canonical.z);
        const uniformValues = terrainHeightUniformValues([
            (canonical.x * tileSize + wrap - minX) / (maxX - minX),
            (canonical.y * tileSize - minY) / (maxY - minY),
            tileSize / (maxX - minX),
            tileSize / (maxY - minY)
        ]);
        const mesh = terrain.getTerrainMesh(tileID, frameRenderContext.data.isRenderingGlobe);
        program.draw(context, gl.TRIANGLES, DepthMode.disabled, StencilMode.disabled, ColorMode.unblended, CullFaceMode.disabled, uniformValues, terrainData, null, 'terrain', mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
    framebuffer.colorAttachment.set(null);
}

/**
 * Returns the ids of the tiles next to the given tiles, at the same zoom, that are not among them.
 */
function getTileIDsAround(tiles: Tile[]): OverscaledTileID[] {
    const keys = new Set(tiles.map(tile => tile.tileID.key));
    const tileIDsAround = new Map<string, OverscaledTileID>();
    for (const {tileID} of tiles) {
        for (const [dx, dy] of NEIGHBOR_OFFSETS) {
            const neighbor = tileID.normalizeCoordinates(dx * EXTENT, dy * EXTENT)?.tileID;
            if (neighbor && !keys.has(neighbor.key)) tileIDsAround.set(neighbor.key, neighbor);
        }
    }
    return [...tileIDsAround.values()];
}

export {
    drawTerrain,
    drawDepth,
    drawTerrainHeightMap
};
