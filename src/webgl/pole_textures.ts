import {Color} from '@maplibre/maplibre-gl-style-spec';
import {Texture} from './texture.ts';
import {RGBAImage} from '../util/image.ts';
import {clamp} from '../util/util.ts';

import type {Context} from './context.ts';
import type {Framebuffer} from './framebuffer.ts';
import type {CanonicalTileID} from '../tile/tile_id.ts';

const EDGE_ROW_SIZE = 4096;

type PoleEdgeTexture = {
    tileID: CanonicalTileID;
    texture: Texture;
};

/**
 * @internal
 * The tiles' edge pixels around each pole, as mipmapped rows that the pole caps blur, with the texels they fill in `coverage`.
 */
export type PoleTextures = {
    north: Texture;
    south: Texture;
    coverage: Texture;
    coverageImage: RGBAImage;
    fbo: Framebuffer;
    readFramebuffer: WebGLFramebuffer;
};

export function bordersPole(tileID: CanonicalTileID): boolean {
    return tileID.y === 0 || tileID.y === (1 << tileID.z) - 1;
}

export function createPoleTextures(context: Context): PoleTextures {
    const gl = context.gl;
    const empty = {width: EDGE_ROW_SIZE, height: 1, data: null};
    const coverageImage = new RGBAImage({width: EDGE_ROW_SIZE, height: 1});
    return {
        north: new Texture(context, empty, gl.RGBA, {premultiply: false, useMipmap: true}),
        south: new Texture(context, empty, gl.RGBA, {premultiply: false, useMipmap: true}),
        coverage: new Texture(context, coverageImage, gl.RGBA, {premultiply: false, useMipmap: true}),
        coverageImage,
        fbo: context.createFramebuffer(EDGE_ROW_SIZE, 1, false, false),
        readFramebuffer: gl.createFramebuffer()
    };
}

export function updatePoleTextures(context: Context, poleTextures: PoleTextures, edges: PoleEdgeTexture[]): void {
    edges.sort((a, b) => a.tileID.z - b.tileID.z);
    poleTextures.coverageImage.data.fill(0);
    updateEdge(context, poleTextures, poleTextures.north, edges.filter(edge => edge.tileID.y === 0), 0, false);
    updateEdge(context, poleTextures, poleTextures.south, edges.filter(edge => edge.tileID.y === (1 << edge.tileID.z) - 1), 1, true);
    poleTextures.coverage.update(poleTextures.coverageImage, {premultiply: false, useMipmap: true});
}

export function bindPoleTextures(context: Context, poleTextures: PoleTextures): void {
    const gl = context.gl;
    context.activeTexture.set(gl.TEXTURE4);
    poleTextures.north.bind(gl.LINEAR, gl.REPEAT, gl.LINEAR_MIPMAP_LINEAR);
    context.activeTexture.set(gl.TEXTURE5);
    poleTextures.south.bind(gl.LINEAR, gl.REPEAT, gl.LINEAR_MIPMAP_LINEAR);
    context.activeTexture.set(gl.TEXTURE6);
    poleTextures.coverage.bind(gl.LINEAR, gl.REPEAT, gl.LINEAR_MIPMAP_LINEAR);
}

function updateEdge(context: Context, poleTextures: PoleTextures, target: Texture, edges: PoleEdgeTexture[], channel: number, lastRow: boolean): void {
    const gl = context.gl;
    const {fbo, coverageImage} = poleTextures;
    context.bindFramebuffer.set(fbo.framebuffer);
    fbo.colorAttachment.set(target.texture);
    context.viewport.set([0, 0, EDGE_ROW_SIZE, 1]);
    context.clear({color: Color.transparent});

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, poleTextures.readFramebuffer);
    for (const {tileID, texture} of edges) {
        const span = EDGE_ROW_SIZE / (1 << tileID.z);
        const [width, height] = texture.size;
        const maxLevel = Math.floor(Math.log2(Math.max(width, height)));
        const level = texture.useMipmap ? clamp(Math.floor(Math.log2(width / span)), 0, maxLevel) : 0;
        const row = lastRow ? Math.max(height >> level, 1) - 1 : 0;
        const left = Math.floor(tileID.x * span);
        const right = Math.max(Math.floor((tileID.x + 1) * span), left + 1);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.texture, level);
        gl.blitFramebuffer(0, row, Math.max(width >> level, 1), row + 1, left, 0, right, 1, gl.COLOR_BUFFER_BIT, gl.LINEAR);
        for (let i = left; i < right; i++) {
            coverageImage.data[i * 4 + channel] = 255;
        }
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo.framebuffer);
    target.generateMipmap();
}
