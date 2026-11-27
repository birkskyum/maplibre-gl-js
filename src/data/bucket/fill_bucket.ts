import {FillLayoutArray} from '../array_types.g.ts';
import {members as layoutAttributes} from './fill_attributes.ts';
import {SegmentVector} from '../segment.ts';
import {ProgramConfigurationSet} from '../program_configuration.ts';
import {LineIndexArray, TriangleIndexArray} from '../index_array_type.ts';
import {register} from '../../util/web_worker_transfer.ts';

import type {
    Bucket,
    BucketParameters
} from '../bucket.ts';
import type {FillStyleLayer} from '../../style/style_layer/fill_style_layer.ts';
import type {Context} from '../../webgl/context.ts';
import type {IndexBuffer} from '../../webgl/index_buffer.ts';
import type {VertexBuffer} from '../../webgl/vertex_buffer.ts';
import type {FeatureStates} from '../../source/source_state.ts';
import type {ImagePosition} from '../../render/image_atlas.ts';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

export class FillBucket implements Bucket {
    index: number;
    zoom: number;
    overscaling: number;
    layers: FillStyleLayer[];
    layerIds: string[];
    stateDependentLayers: FillStyleLayer[];
    stateDependentLayerIds: string[];

    layoutVertexArray: FillLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    indexArray2: LineIndexArray;
    indexBuffer2: IndexBuffer;

    sdfPatterns: Record<string, boolean>;
    programConfigurations: ProgramConfigurationSet<FillStyleLayer>;
    segments: SegmentVector;
    segments2: SegmentVector;
    uploaded: boolean;

    constructor(options: BucketParameters<FillStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.sdfPatterns = {};

        this.layoutVertexArray = new FillLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.indexArray2 = new LineIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.segments2 = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
    }

    update(states: FeatureStates, vtLayer: VectorTileLayerLike, imagePositions: {
        [_: string]: ImagePosition;
    }): void {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {
            imagePositions
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
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
            this.indexBuffer2 = context.createIndexBuffer(this.indexArray2);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy(): void {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.indexBuffer2.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
        this.segments2.destroy();
    }
}

register('FillBucket', FillBucket, {omit: ['layers']});
