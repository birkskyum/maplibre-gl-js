import {CircleBucket} from './circle_bucket.ts';
import {CircleBucketBuilder} from './circle_bucket_builder.ts';
import {FillBucket} from './fill_bucket.ts';
import {FillBucketBuilder} from './fill_bucket_builder.ts';
import {FillExtrusionBucket} from './fill_extrusion_bucket.ts';
import {FillExtrusionBucketBuilder} from './fill_extrusion_bucket_builder.ts';
import {HeatmapBucket} from './heatmap_bucket.ts';
import {LineBucket} from './line_bucket.ts';
import {LineBucketBuilder} from './line_bucket_builder.ts';
import {SymbolBucket} from './symbol_bucket.ts';
import {SymbolBucketBuilder} from './symbol_bucket_builder.ts';

import type {BucketBuilder, BucketParameters} from '../bucket.ts';
import type {StyleLayer} from '../../style/style_layer.ts';

/**
 * Creates an empty bucket for a family of layers, along with the builder that fills it on the worker.
 *
 * @param layer - A layer of the family, which decides the kind of bucket.
 */
export function createBucketBuilder(layer: StyleLayer, parameters: BucketParameters<any>): BucketBuilder {
    switch (layer.type) {
        case 'circle':
            return new CircleBucketBuilder(new CircleBucket(parameters));
        case 'fill':
            return new FillBucketBuilder(new FillBucket(parameters));
        case 'fill-extrusion':
            return new FillExtrusionBucketBuilder(new FillExtrusionBucket(parameters));
        case 'heatmap':
            return new CircleBucketBuilder(new HeatmapBucket(parameters));
        case 'line':
            return new LineBucketBuilder(new LineBucket(parameters));
        case 'symbol':
            return new SymbolBucketBuilder(new SymbolBucket(parameters));
    }
}
