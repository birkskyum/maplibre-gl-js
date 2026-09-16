import {StencilMode} from './stencil_mode.ts';
import {CullFaceMode} from './cull_face_mode.ts';
import {getProjectionDataForTile, getTerrainDataForTile, type RenderContext, type RenderPass} from '../render/render_context.ts';

import type {Program, DrawMode} from './program.ts';
import type {UniformBindings, UniformValues} from './uniform_binding.ts';
import type {Mesh} from '../render/mesh.ts';
import type {Context} from './context.ts';
import type {Painter} from '../render/painter.ts';
import type {OverscaledTileID} from '../tile/tile_id.ts';
import type {DepthMaskType} from './types.ts';
import type {LayerTweaker} from './layer_tweaker.ts';

export type DrawableTextureBinding = {
    unit: number;
    texture: {bind(context: Context): void};
};

/** Projection, terrain and depth state are resolved at draw time for the current render target. */
export class Drawable<Us extends UniformBindings> {
    required = false;
    uniformValues: UniformValues<Us>;
    tileID: OverscaledTileID;
    renderPass: RenderPass;
    depthMask: DepthMaskType;
    sublayer = 0;
    stencilMode: Readonly<StencilMode> = StencilMode.disabled;
    cullFaceMode: Readonly<CullFaceMode> = CullFaceMode.disabled;
    textures: DrawableTextureBinding[] = [];

    constructor(
        public program: Program<Us>,
        public mesh: Mesh,
        public layerID: string,
        public drawMode: DrawMode
    ) {}

    draw(painter: Painter, renderContext: RenderContext): void {
        if (this.renderPass !== renderContext.currentPass) return;

        const context = painter.context;
        const projectionData = getProjectionDataForTile(renderContext, this.tileID);
        const terrain = getTerrainDataForTile(renderContext, this.tileID);
        for (const {unit, texture} of this.textures) {
            context.activeTexture.set(context.gl.TEXTURE0 + unit);
            texture.bind(context);
        }
        const depthMode = painter.getDepthModeForSublayer(this.sublayer, this.depthMask);
        const colorMode = painter.colorModeForRenderPass();
        this.program.draw(context, this.drawMode, depthMode, this.stencilMode, colorMode, this.cullFaceMode,
            this.uniformValues, terrain, projectionData, this.layerID,
            this.mesh.vertexBuffer, this.mesh.indexBuffer, this.mesh.segments);
    }
}

/** Retains drawables between updates without owning their GPU resources. */
export class DrawableCollection<Us extends UniformBindings> {
    entries: Map<string, Drawable<Us>> = new Map();

    constructor(public tweaker?: LayerTweaker<Us>) {}

    update(painter: Painter, renderContext: RenderContext): void {
        this.tweaker?.(this, painter, renderContext);
    }

    /** Creates or reuses a drawable and marks it as required for this update. */
    get(key: string, program: Program<Us>, mesh: Mesh, layerID: string, drawMode: DrawMode): Drawable<Us> {
        let drawable = this.entries.get(key);
        if (!drawable) {
            drawable = new Drawable(program, mesh, layerID, drawMode);
            this.entries.set(key, drawable);
        }
        drawable.program = program;
        drawable.mesh = mesh;
        drawable.layerID = layerID;
        drawable.drawMode = drawMode;
        drawable.required = true;
        return drawable;
    }

    /** Removes entries not requested with `get()` since the previous call. */
    endUpdate(): void {
        for (const [key, drawable] of this.entries) {
            if (!drawable.required) this.entries.delete(key);
            drawable.required = false;
        }
    }
}
