import {DepthMode} from '../gl/depth_mode.ts';
import {StencilMode} from '../gl/stencil_mode.ts';
import {CullFaceMode} from '../gl/cull_face_mode.ts';
import {debugUniformValues} from './program/debug_program.ts';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {ColorMode} from '../gl/color_mode.ts';

import type {Painter} from './painter.ts';
import type {SourceCache} from '../source/source_cache.ts';
import type {OverscaledTileID} from '../source/tile_id.ts';
import {Style} from '../style/style.ts';

const topColor = new Color(1, 0, 0, 1);
const btmColor = new Color(0, 1, 0, 1);
const leftColor = new Color(0, 0, 1, 1);
const rightColor = new Color(1, 0, 1, 1);
const centerColor = new Color(0, 1, 1, 1);

export function drawDebugPadding(painter: Painter) {
    const padding = painter.transform.padding;
    const lineWidth = 3;
    // Top
    drawHorizontalLine(painter, painter.transform.height - (padding.top || 0), lineWidth, topColor);
    // Bottom
    drawHorizontalLine(painter, padding.bottom || 0, lineWidth, btmColor);
    // Left
    drawVerticalLine(painter, padding.left || 0, lineWidth, leftColor);
    // Right
    drawVerticalLine(painter, painter.transform.width - (padding.right || 0), lineWidth, rightColor);
    // Center
    const center = painter.transform.centerPoint;
    drawCrosshair(painter, center.x, painter.transform.height - center.y, centerColor);
}

function drawCrosshair(painter: Painter, x: number, y: number, color: Color) {
    const size = 20;
    const lineWidth = 2;
    //Vertical line
    drawDebugSSRect(painter, x - lineWidth / 2, y - size / 2, lineWidth, size, color);
    //Horizontal line
    drawDebugSSRect(painter, x - size / 2, y - lineWidth / 2, size, lineWidth, color);
}

function drawHorizontalLine(painter: Painter, y: number, lineWidth: number, color: Color) {
    drawDebugSSRect(painter, 0, y  + lineWidth / 2, painter.transform.width,  lineWidth, color);
}

function drawVerticalLine(painter: Painter, x: number, lineWidth: number, color: Color) {
    drawDebugSSRect(painter, x - lineWidth / 2, 0, lineWidth,  painter.transform.height, color);
}

function drawDebugSSRect(painter: Painter, x: number, y: number, width: number, height: number, color: Color) {
    const context = painter.context;
    const gl = context.gl;

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x * painter.pixelRatio, y * painter.pixelRatio, width * painter.pixelRatio, height * painter.pixelRatio);
    context.clear({color});
    gl.disable(gl.SCISSOR_TEST);
}

export function drawDebug(painter: Painter, sourceCache: SourceCache, coords: Array<OverscaledTileID>) {
    for (let i = 0; i < coords.length; i++) {
        drawDebugTile(painter, sourceCache, coords[i]);
    }
}

function drawDebugTile(painter: Painter, sourceCache: SourceCache, coord: OverscaledTileID) {
    const context = painter.context;
    const gl = context.gl;

    const posMatrix = coord.posMatrix;
    const program = painter.useProgram('debug');

    const depthMode = DepthMode.disabled;
    const stencilMode = StencilMode.disabled;
    const colorMode = painter.colorModeForRenderPass();
    const id = '$debug';
    const terrainData = painter.style.map.terrain && painter.style.map.terrain.getTerrainData(coord);

    context.activeTexture.set(gl.TEXTURE0);

    const tileRawData = sourceCache.getTileByID(coord.key).latestRawTileData;
    const tileByteLength = (tileRawData && tileRawData.byteLength) || 0;
    const tileSizeKb = Math.floor(tileByteLength / 1024);
    const tileSize = sourceCache.getTile(coord).tileSize;
    const scaleRatio = (512 / Math.min(tileSize, 512) * (coord.overscaledZ / painter.transform.zoom)) * 0.5;
    let tileIdText = coord.canonical.toString();
    if (coord.overscaledZ !== coord.canonical.z) {
        tileIdText += ` => ${coord.overscaledZ}`;
    }
    const tileLabel = `${tileIdText} ${tileSizeKb}kB`;
    drawTextToOverlay(painter, tileLabel);

    program.draw(context, gl.TRIANGLES, depthMode, stencilMode, ColorMode.alphaBlended, CullFaceMode.disabled,
        debugUniformValues(posMatrix, Color.transparent, scaleRatio), null, id,
        painter.debugBuffer, painter.quadTriangleIndexBuffer, painter.debugSegments);
    program.draw(context, gl.LINE_STRIP, depthMode, stencilMode, colorMode, CullFaceMode.disabled,
        debugUniformValues(posMatrix, Color.red), terrainData, id,
        painter.debugBuffer, painter.tileBorderIndexBuffer, painter.debugSegments);
}

function drawTextToOverlay(painter: Painter, text: string) {
    painter.initDebugOverlayCanvas();
    const canvas = painter.debugOverlayCanvas;
    const gl = painter.context.gl;
    const ctx2d = painter.debugOverlayCanvas.getContext('2d');
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);

    ctx2d.shadowColor = 'white';
    ctx2d.shadowBlur = 2;
    ctx2d.lineWidth = 1.5;
    ctx2d.strokeStyle = 'white';
    ctx2d.textBaseline = 'top';
    ctx2d.font = `bold ${36}px Open Sans, sans-serif`;
    ctx2d.fillText(text, 5, 5);
    ctx2d.strokeText(text, 5, 5);

    painter.debugOverlayTexture.update(canvas);
    painter.debugOverlayTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
}

export function selectDebugSource(style: Style, zoom: number): SourceCache | null {
    // Use vector source with highest maxzoom
    // Else use source with highest maxzoom of any type
    let selectedSource: SourceCache = null;
    const layers = Object.values(style._layers);
    const sources = layers.flatMap((layer) => {
        if (layer.source && !layer.isHidden(zoom)) {
            const sourceCache = style.sourceCaches[layer.source];
            return [sourceCache];
        } else {
            return [];
        }
    });
    const vectorSources = sources.filter((source) => source.getSource().type === 'vector');
    const otherSources = sources.filter((source) => source.getSource().type !== 'vector');
    const considerSource = (source: SourceCache) => {
        if (!selectedSource || (selectedSource.getSource().maxzoom < source.getSource().maxzoom)) {
            selectedSource = source;
        }
    };
    vectorSources.forEach((source) => considerSource(source));
    if (!selectedSource) {
        otherSources.forEach((source) => considerSource(source));
    }
    return selectedSource;
}
