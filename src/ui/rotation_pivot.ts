import Point from '@mapbox/point-geometry';

import type {LngLat} from '../geo/lng_lat.ts';
import type {IReadonlyTransform, ITransform} from '../geo/transform_interface.ts';
import type {Terrain} from '../render/terrain.ts';
import type {HandlerResult} from './handler_manager.ts';

/**
 * The point a drag turns the camera around, which keeps its screen point and its distance in meters from the camera.
 */
export type RotationPivot = {
    point: Point;
    location: LngLat;
    elevation: number;
    distance: number;
};

/**
 * Picks the terrain under the point where a drag starts, or the ground at the center's elevation where the terrain has
 * not loaded, and the center of the map where the point is in the sky or close to the horizon.
 */
export function captureRotationPivot(tr: IReadonlyTransform, point: Point, terrain: Terrain | null): RotationPivot {
    if (!isBelowHorizon(tr, point)) {
        return {point: tr.centerPoint, location: tr.center, elevation: tr.elevation, distance: distanceFromCamera(tr, tr.center, tr.elevation)};
    }
    const hit = terrain ? tr.screenTerrainPointToMercatorCoordinate(point, terrain) : null;
    const elevation = hit ? hit.z : tr.elevation;
    const location = hit ? hit.toLngLat() : tr.screenPointToLocationAtElevation(point, elevation);
    return {point, location, elevation, distance: distanceFromCamera(tr, location, elevation)};
}

/**
 * Turns the camera by a frame's deltas around the pivot, so that tilting also zooms. A frame that would bring the pivot
 * close to the horizon or the camera into the terrain keeps only its change of bearing, or nothing where that does too.
 */
export function orbitRotationPivot(tr: ITransform, pivot: RotationPivot, deltas: HandlerResult, terrain: Terrain | null): void {
    const camera = turnAroundPivot(tr, pivot, deltas, terrain) ?? turnAroundPivot(tr, pivot, {bearingDelta: deltas.bearingDelta}, terrain);
    if (camera) tr.apply(camera, false);
}

/**
 * The camera turned by the deltas around the pivot, or null where the pivot would come close to the horizon or the camera
 * would sink below the center's elevation or into terrain that it is not inside already.
 */
function turnAroundPivot(start: ITransform, pivot: RotationPivot, deltas: HandlerResult, terrain: Terrain | null): ITransform | null {
    const camera = start.clone();
    camera.setBearing(start.bearing + (deltas.bearingDelta || 0));
    camera.setPitch(start.pitch + (deltas.pitchDelta || 0));
    camera.setRoll(start.roll + (deltas.rollDelta || 0));
    if (!isBelowHorizon(camera, pivot.point) || !holdPivot(camera, pivot)) return null;
    return isAboveTerrain(camera, terrain) || !isAboveTerrain(start, terrain) ? camera : null;
}

/**
 * Zooms and moves a turned camera so that the pivot is at its screen point and distance, twice, as moving the center
 * changes the scale of the map with the latitude. False where the camera would not be above the center's elevation.
 */
function holdPivot(tr: ITransform, pivot: RotationPivot): boolean {
    for (let solve = 0; solve < 2; solve++) {
        const height = tr.getCameraAltitude() - tr.elevation;
        const ground = tr.screenPointToLocation(pivot.point);
        const descent = height / Math.hypot(height, tr.getCameraLngLat().distanceTo(ground));
        const targetHeight = pivot.distance * descent + pivot.elevation - tr.elevation;
        if (height <= 0 || targetHeight <= 0) return false;
        tr.setZoom(tr.zoom + Math.log2(height / targetHeight));
        tr.setLocationAtPoint(pivot.location, pivot.point, pivot.elevation);
    }
    return true;
}

/**
 * Whether the point is at least 16 pixels below the horizon, closer to which a pixel spans too much ground to hold a pivot.
 */
function isBelowHorizon(tr: IReadonlyTransform, point: Point): boolean {
    return tr.isPointOnMapSurface(new Point(point.x, point.y - 16));
}

function distanceFromCamera(tr: IReadonlyTransform, location: LngLat, elevation: number): number {
    return Math.hypot(tr.getCameraLngLat().distanceTo(location), tr.getCameraAltitude() - elevation);
}

function isAboveTerrain(tr: IReadonlyTransform, terrain: Terrain | null): boolean {
    return !terrain || tr.getCameraAltitude() >= terrain.getElevationForLngLatZoom(tr.getCameraLngLat(), tr.zoom);
}
