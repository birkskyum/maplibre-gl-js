import {LineLayoutArray, LineExtLayoutArray, LineOffsetLayoutArray} from '../array_types.g.ts';
import {members as layoutAttributes} from './line_attributes.ts';
import {members as layoutAttributesExt} from './line_attributes_ext.ts';
import {members as layoutAttributesOffset} from './line_attributes_offset.ts';
import {SegmentVector} from '../segment.ts';
import {ProgramConfigurationSet} from '../program_configuration.ts';
import {TriangleIndexArray} from '../array_types.g.ts';
import {register} from '../../util/web_worker_transfer.ts';

import type {
    Bucket,
    BucketParameters
} from '../bucket.ts';
import type {LineStyleLayer} from '../../style/style_layer/line_style_layer.ts';
import type {RGBAImage} from '../../util/image.ts';
import type {Context} from '../../webgl/context.ts';
import type {Texture} from '../../webgl/texture.ts';
import type {IndexBuffer} from '../../webgl/index_buffer.ts';
import type {VertexBuffer} from '../../webgl/vertex_buffer.ts';
import type {FeatureStates} from '../../source/source_state.ts';
import type {ImagePosition} from '../../render/image_atlas.ts';
import type {DashEntry} from '../../render/line_atlas.ts';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

/** Whether a layer draws dashes along a `line-offset` line, which needs {@link LineBucket.offsetDistanceArray}. */
function dashesOffsetLine(layer: LineStyleLayer): boolean {
    return !!layer.paint.get('line-dasharray').constantOr(1 as any) &&
        layer.paint.get('line-offset').constantOr(1) !== 0;
}

export type LineClips = {
    start: number;
    end: number;
};

type GradientTexture = {
    texture?: Texture;
    gradient?: RGBAImage;
    version?: number;
};

/**
 * @internal
 * Line bucket class
 */
export class LineBucket implements Bucket {
    maxLineLength: number;
    index: number;
    zoom: number;
    overscaling: number;
    layers: LineStyleLayer[];
    layerIds: string[];
    gradients: {[x: string]: GradientTexture};
    stateDependentLayers: any[];
    stateDependentLayerIds: string[];
    lineClipsArray: LineClips[];

    layoutVertexArray: LineLayoutArray;
    layoutVertexBuffer: VertexBuffer;
    layoutVertexArray2: LineExtLayoutArray;
    layoutVertexBuffer2: VertexBuffer;

    /**
     * Per vertex, how much longer the `line-offset` line is than the line itself up to that vertex, per unit of
     * offset. An offset line is shorter on the inside of a turn and longer on the outside, so dashes measured along
     * the line itself would be squeezed or stretched there. Filled only when a layer draws dashes with an offset.
     */
    offsetDistanceArray?: LineOffsetLayoutArray;
    offsetDistanceBuffer?: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    programConfigurations: ProgramConfigurationSet<LineStyleLayer>;
    segments: SegmentVector;
    uploaded: boolean;

    constructor(options: BucketParameters<LineStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.lineClipsArray = [];
        this.gradients = {};
        for (const layer of this.layers) {
            this.gradients[layer.id] = {};
        }

        this.layoutVertexArray = new LineLayoutArray();
        this.layoutVertexArray2 = new LineExtLayoutArray();
        this.offsetDistanceArray = this.layers.some(dashesOffsetLine) ? new LineOffsetLayoutArray() : undefined;
        this.offsetDistanceBuffer = undefined;
        this.indexArray = new TriangleIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.maxLineLength = 0;

        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
    }

    update(states: FeatureStates, vtLayer: VectorTileLayerLike, imagePositions: {[_: string]: ImagePosition}, dashPositions: {[_: string]: DashEntry}): void {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {
            imagePositions,
            dashPositions
        });
    }

    isEmpty(): boolean {
        return this.layoutVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context): void {
        if (!this.uploaded) {
            if (this.layoutVertexArray2.length !== 0) {
                this.layoutVertexBuffer2 = context.createVertexBuffer(this.layoutVertexArray2, layoutAttributesExt);
            }
            if (this.offsetDistanceArray?.length) {
                this.offsetDistanceBuffer = context.createVertexBuffer(this.offsetDistanceArray, layoutAttributesOffset);
            }
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy(): void {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.offsetDistanceBuffer?.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
    }
}

register('LineBucket', LineBucket, {omit: ['layers']});
