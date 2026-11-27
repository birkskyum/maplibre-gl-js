import {FillExtrusionLayoutArray, PosArray} from '../array_types.g.ts';
import {members as layoutAttributes, centroidAttributes} from './fill_extrusion_attributes.ts';
import {SegmentVector} from '../segment.ts';
import {ProgramConfigurationSet} from '../program_configuration.ts';
import {TriangleIndexArray} from '../index_array_type.ts';
import {register} from '../../util/web_worker_transfer.ts';

import type {
    Bucket,
    BucketParameters
} from '../bucket.ts';
import type {FillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer.ts';
import type {Context} from '../../webgl/context.ts';
import type {IndexBuffer} from '../../webgl/index_buffer.ts';
import type {VertexBuffer} from '../../webgl/vertex_buffer.ts';
import type {FeatureStates} from '../../source/source_state.ts';
import type {ImagePosition} from '../../render/image_atlas.ts';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

export class FillExtrusionBucket implements Bucket {
    index: number;
    zoom: number;
    overscaling: number;
    layers: FillExtrusionStyleLayer[];
    layerIds: string[];
    stateDependentLayers: FillExtrusionStyleLayer[];
    stateDependentLayerIds: string[];

    layoutVertexArray: FillExtrusionLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    centroidVertexArray: PosArray;
    centroidVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    programConfigurations: ProgramConfigurationSet<FillExtrusionStyleLayer>;
    segments: SegmentVector;
    uploaded: boolean;

    constructor(options: BucketParameters<FillExtrusionStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;

        this.layoutVertexArray = new FillExtrusionLayoutArray();
        this.centroidVertexArray = new PosArray();
        this.indexArray = new TriangleIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
    }

    update(states: FeatureStates, vtLayer: VectorTileLayerLike, imagePositions: {[_: string]: ImagePosition}): void {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {
            imagePositions
        });
    }

    isEmpty(): boolean {
        return this.layoutVertexArray.length === 0 && this.centroidVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context): void {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.centroidVertexBuffer = context.createVertexBuffer(this.centroidVertexArray, centroidAttributes.members, true);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy(): void {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
        this.centroidVertexBuffer.destroy();
    }
}

register('FillExtrusionBucket', FillExtrusionBucket, {omit: ['layers']});
