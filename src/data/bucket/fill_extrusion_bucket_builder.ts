import {type Segment, SegmentVector} from '../segment.ts';
import {isBoundaryEdge, isEntirelyOutside} from '../extent_bounds.ts';
import {VectorTileFeature} from '@mapbox/vector-tile';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {hasPattern, addPatternDependencies} from './pattern_bucket_features.ts';
import {loadGeometry} from '../load_geometry.ts';
import {toEvaluationFeature} from '../evaluation_feature.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {subdividePolygon, subdivideVertexLine} from '../../render/subdivision.ts';
import {fillLargeMeshArrays} from '../../render/fill_large_mesh_arrays.ts';
import {getTileUnitsForMeters, roundPolygonCornersIfNeeded, roundedWallNormals} from './round_polygon_corners.ts';

import type {CanonicalTileID} from '../../tile/tile_id.ts';
import type {
    BucketBuilder,
    BucketFeature,
    BucketDependencyParameters,
    IndexedFeature,
    PopulateParameters
} from '../bucket.ts';
import type Point from '@mapbox/point-geometry';
import type {ImagePosition} from '../../render/image_atlas.ts';
import type {SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';
import type {FillExtrusionBucket} from './fill_extrusion_bucket.ts';

const EARCUT_MAX_RINGS = 500;

const FACTOR = Math.pow(2, 13);

function addVertex(vertexArray, x, y, nx, ny, nz, t, e) {
    vertexArray.emplaceBack(
        // a_pos
        x,
        y,
        // a_normal_ed: 3-component normal and 1-component edgedistance
        Math.floor(nx * FACTOR) * 2 + t,
        ny * FACTOR * 2,
        nz * FACTOR * 2,
        // edgedistance (used for wrapping patterns around extrusion sides)
        Math.round(e)
    );
}

type CentroidAccumulator = {
    x: number;
    y: number;
    sampleCount: number;
};

/**
 * @internal
 * Builds a {@link FillExtrusionBucket} on the worker.
 */
export class FillExtrusionBucketBuilder implements BucketBuilder {
    readonly bucket: FillExtrusionBucket;
    hasDependencies: boolean;
    features: BucketFeature[];

    constructor(bucket: FillExtrusionBucket) {
        this.bucket = bucket;
        this.hasDependencies = false;
    }

    populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
        this.features = [];
        this.hasDependencies = hasPattern('fill-extrusion', this.bucket.layers, options);

        const globalProperties = new EvaluationParameters(this.bucket.zoom);
        const layer = this.bucket.layers[0];
        const roundedCornerDistanceInMeters = layer.layout.get('fill-extrusion-rounded-corner-distance');
        const roundedCornerDistance = roundedCornerDistanceInMeters > 0 ? getTileUnitsForMeters(roundedCornerDistanceInMeters, canonical) : 0;
        const needGeometry = layer._featureFilter.needGeometry;

        for (const {feature, id, index, sourceLayerIndex} of features) {
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);

            if (!layer._featureFilter.filter(globalProperties, evaluationFeature, canonical)) continue;

            const rawGeometry = needGeometry ? evaluationFeature.geometry : loadGeometry(feature);
            const geometry = roundPolygonCornersIfNeeded(rawGeometry, roundedCornerDistance);

            const bucketFeature: BucketFeature = {
                id,
                sourceLayerIndex,
                index,
                geometry,
                properties: feature.properties,
                type: feature.type,
                patterns: {}
            };

            if (this.hasDependencies) {
                this.features.push(addPatternDependencies('fill-extrusion', this.bucket.layers, bucketFeature, {zoom: this.bucket.zoom}, options));
            } else {
                this.addFeature(bucketFeature, bucketFeature.geometry, index, canonical, {}, options.subdivisionGranularity);
            }

            options.featureIndex.insert(feature, bucketFeature.geometry, index, sourceLayerIndex, this.bucket.index, true);
        }
    }

    addFeatures({options, canonical, patternPositions}: BucketDependencyParameters): void {
        for (const feature of this.features) {
            const {geometry} = feature;
            this.addFeature(feature, geometry, feature.index, canonical, patternPositions, options.subdivisionGranularity);
        }
    }

    addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID, imagePositions: {[_: string]: ImagePosition}, subdivisionGranularity: SubdivisionGranularitySetting): void {
        for (const polygon of classifyRings(geometry, EARCUT_MAX_RINGS)) {
            // Compute polygon centroid to calculate elevation in GPU
            const centroid: CentroidAccumulator = {x: 0, y: 0, sampleCount: 0};
            const oldVertexCount = this.bucket.layoutVertexArray.length;
            this.processPolygon(centroid, canonical, feature, polygon, subdivisionGranularity);

            const addedVertices = this.bucket.layoutVertexArray.length - oldVertexCount;

            const centroidX = Math.floor(centroid.x / centroid.sampleCount);
            const centroidY = Math.floor(centroid.y / centroid.sampleCount);

            for (let i = 0; i < addedVertices; i++) {
                this.bucket.centroidVertexArray.emplaceBack(
                    centroidX,
                    centroidY
                );
            }
        }

        this.bucket.programConfigurations.populatePaintArrays(this.bucket.layoutVertexArray.length, feature, index, {imagePositions, canonical});
    }

    private processPolygon(
        centroid: CentroidAccumulator,
        canonical: CanonicalTileID,
        feature: BucketFeature,
        polygon: Point[][],
        subdivisionGranularity: SubdivisionGranularitySetting
    ): void {
        if (polygon.length < 1) {
            return;
        }

        if (isEntirelyOutside(polygon[0])) {
            return;
        }

        // Only consider the un-subdivided polygon outer ring for centroid calculation
        for (const ring of polygon) {
            if (ring.length === 0) {
                continue;
            }

            // Here we don't mind if a hole ring is entirely outside, unlike when generating geometry later.
            accumulatePointsToCentroid(centroid, ring);
        }

        const segmentReference = {
            segment: this.bucket.segments.prepareSegment(4, this.bucket.layoutVertexArray, this.bucket.indexArray)
        };
        const granularity = subdivisionGranularity.fill.getGranularityForZoomLevel(canonical.z);
        const isPolygon = VectorTileFeature.types[feature.type] === 'Polygon';

        for (const ring of polygon) {
            if (ring.length === 0) {
                continue;
            }

            if (isEntirelyOutside(ring)) {
                continue;
            }

            const subdividedRing = subdivideVertexLine(ring, granularity, isPolygon);
            this._generateSideFaces(subdividedRing, segmentReference);
        }

        // Only triangulate and draw the area of the feature if it is a polygon
        // Other feature types (e.g. LineString) do not have area, so triangulation is pointless / undefined
        if (!isPolygon)
            return;

        // Do not generate outlines, since outlines already got subdivided earlier.
        const subdividedPolygon = subdividePolygon(polygon, canonical, granularity, false);
        const vertexArray = this.bucket.layoutVertexArray;

        fillLargeMeshArrays(
            (x, y) => {
                addVertex(vertexArray, x, y, 0, 0, 1, 1, 0);
            },
            this.bucket.segments,
            this.bucket.layoutVertexArray,
            this.bucket.indexArray,
            subdividedPolygon.verticesFlattened,
            subdividedPolygon.indicesTriangles
        );
    }

    /**
     * Generates side faces for the supplied geometry. Assumes `geometry` to be a line string, like the output of {@link subdivideVertexLine}.
     * For rings, it is assumed that the first and last vertex of `geometry` are equal.
     */
    private _generateSideFaces(geometry: Point[], segmentReference: {segment: Segment}): void {
        let edgeDistance = 0;
        const hasRoundedCorners = this.bucket.layers[0].layout.get('fill-extrusion-rounded-corner-distance') > 0;
        const wallNormals = hasRoundedCorners ? roundedWallNormals(geometry) : null;

        for (let p = 1; p < geometry.length; p++) {
            const p1 = geometry[p];
            const p2 = geometry[p - 1];

            if (isBoundaryEdge(p1, p2) || (wallNormals && !wallNormals[p])) {
                continue;
            }

            if (segmentReference.segment.vertexLength + 4 > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
                segmentReference.segment = this.bucket.segments.prepareSegment(4, this.bucket.layoutVertexArray, this.bucket.indexArray);
            }

            const perp = p1.sub(p2)._perp()._unit();
            const {start, end} = wallNormals ? wallNormals[p] : {start: perp, end: perp};
            const dist = p2.dist(p1);
            if (edgeDistance + dist > 32768) edgeDistance = 0;

            addVertex(this.bucket.layoutVertexArray, p1.x, p1.y, end.x, end.y, 0, 0, edgeDistance);
            addVertex(this.bucket.layoutVertexArray, p1.x, p1.y, end.x, end.y, 0, 1, edgeDistance);

            edgeDistance += dist;

            addVertex(this.bucket.layoutVertexArray, p2.x, p2.y, start.x, start.y, 0, 0, edgeDistance);
            addVertex(this.bucket.layoutVertexArray, p2.x, p2.y, start.x, start.y, 0, 1, edgeDistance);

            const bottomRight = segmentReference.segment.vertexLength;

            // ┌──────┐
            // │ 0  1 │ Counter-clockwise winding order.
            // │      │ Triangle 1: 0 => 2 => 1
            // │ 2  3 │ Triangle 2: 1 => 2 => 3
            // └──────┘
            this.bucket.indexArray.emplaceBack(bottomRight, bottomRight + 2, bottomRight + 1);
            this.bucket.indexArray.emplaceBack(bottomRight + 1, bottomRight + 2, bottomRight + 3);

            segmentReference.segment.vertexLength += 4;
            segmentReference.segment.primitiveLength += 2;
        }
    }
}

/**
 * Accumulates geometry to centroid. Geometry can be either a polygon ring, a line string or a closed line string.
 * In case of a polygon ring or line ring, the last vertex is ignored if it is the same as the first vertex.
 */
function accumulatePointsToCentroid(centroid: CentroidAccumulator, geometry: Point[]): void {
    for (let i = 0; i < geometry.length; i++) {
        const p = geometry[i];

        if (i === geometry.length - 1 && geometry[0].x === p.x && geometry[0].y === p.y) {
            continue;
        }

        centroid.x += p.x;
        centroid.y += p.y;
        centroid.sampleCount++;
    }
}
