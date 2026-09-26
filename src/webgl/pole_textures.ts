import {Color} from '@maplibre/maplibre-gl-style-spec';
import {Texture} from './texture.ts';
import {RGBAImage} from '../util/image.ts';
import {clamp} from '../util/util.ts';

import type {Context} from './context.ts';
import type {Framebuffer} from './framebuffer.ts';
import type {CanonicalTileID} from '../tile/tile_id.ts';

/** Texels around a pole in each edge row texture. */
const EDGE_ROW_SIZE = 4096;

type PoleEdgeTexture = {
    tileID: CanonicalTileID;
    texture: Pick<Texture, 'texture' | 'size' | 'useMipmap'>;
};

export function bordersPole(tileID: CanonicalTileID): boolean {
    return tileID.y === 0 || tileID.y === (1 << tileID.z) - 1;
}

/**
 * @internal
 * The tiles' edge pixels around each pole, as mipmapped rows that the pole caps blur, with the texels they fill in `coverage`.
 */
export class PoleTextures {
    context: Context;
    north: Texture;
    south: Texture;
    coverage: Texture;
    private _coverageImage: RGBAImage;
    private _fbo: Framebuffer;
    private _readFramebuffer: WebGLFramebuffer;

    constructor(context: Context) {
        const gl = context.gl;
        const empty = {width: EDGE_ROW_SIZE, height: 1, data: null};
        this.context = context;
        this.north = new Texture(context, empty, gl.RGBA, {premultiply: false, useMipmap: true});
        this.south = new Texture(context, empty, gl.RGBA, {premultiply: false, useMipmap: true});
        this._coverageImage = new RGBAImage({width: EDGE_ROW_SIZE, height: 1});
        this.coverage = new Texture(context, this._coverageImage, gl.RGBA, {premultiply: false, useMipmap: true});
        this._fbo = context.createFramebuffer(EDGE_ROW_SIZE, 1, false, false);
        this._readFramebuffer = gl.createFramebuffer();
    }

    update(edges: PoleEdgeTexture[], northRowLast: boolean, border: number): void {
        edges.sort((a, b) => a.tileID.z - b.tileID.z);
        this._coverageImage.data.fill(0);
        this._updateEdge(this.north, edges.filter(edge => edge.tileID.y === 0), 0, northRowLast, border);
        this._updateEdge(this.south, edges.filter(edge => edge.tileID.y === (1 << edge.tileID.z) - 1), 1, !northRowLast, border);
        this.coverage.update(this._coverageImage, {premultiply: false, useMipmap: true});
    }

    bind(): void {
        const context = this.context;
        const gl = context.gl;
        context.activeTexture.set(gl.TEXTURE4);
        this.north.bind(gl.LINEAR, gl.REPEAT, gl.LINEAR_MIPMAP_LINEAR);
        context.activeTexture.set(gl.TEXTURE5);
        this.south.bind(gl.LINEAR, gl.REPEAT, gl.LINEAR_MIPMAP_LINEAR);
        context.activeTexture.set(gl.TEXTURE6);
        this.coverage.bind(gl.LINEAR, gl.REPEAT, gl.LINEAR_MIPMAP_LINEAR);
    }

    private _updateEdge(target: Texture, edges: PoleEdgeTexture[], channel: number, lastRow: boolean, border: number): void {
        const context = this.context;
        const gl = context.gl;
        context.bindFramebuffer.set(this._fbo.framebuffer);
        this._fbo.colorAttachment.set(target.texture);
        context.viewport.set([0, 0, EDGE_ROW_SIZE, 1]);
        context.clear({color: Color.transparent});

        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._readFramebuffer);
        for (const {tileID, texture} of edges) {
            const span = EDGE_ROW_SIZE / (1 << tileID.z);
            const [width, height] = texture.size;
            const maxLevel = Math.floor(Math.log2(Math.max(width, height)));
            const level = texture.useMipmap ? clamp(Math.floor(Math.log2(width / span)), 0, maxLevel) : 0;
            const rows = border + 1;
            const bottom = lastRow ? Math.max(height >> level, rows) - rows : 0;
            const left = Math.floor(tileID.x * span);
            const right = Math.max(Math.floor((tileID.x + 1) * span), left + 1);
            gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.texture, level);
            gl.blitFramebuffer(border, bottom, Math.max(width >> level, 1) - border, bottom + rows, left, 0, right, 1, gl.COLOR_BUFFER_BIT, gl.LINEAR);
            for (let i = left; i < right; i++) {
                this._coverageImage.data[i * 4 + channel] = 255;
            }
        }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._fbo.framebuffer);
        target.generateMipmap();
    }
}
