import {describe, test, expect, vi} from 'vitest';
import {createRenderOptions, getProjectionData, getTerrainData} from './render_options.ts';
import {MercatorTransform} from '../geo/projection/mercator_transform.ts';
import {MercatorProjection} from '../geo/projection/mercator_projection.ts';
import {GlobeProjection} from '../geo/projection/globe_projection.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import type {Terrain, TerrainData} from './terrain.ts';

function createTestContext() {
    const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
    const transform = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: true});
    transform.resize(512, 512);
    const terrainData = {tile: null} as any as TerrainData;
    const terrain = {getTerrainData: vi.fn(() => terrainData)} as any as Terrain;
    return {tileID, transform, terrainData, terrain};
}

describe('RenderOptions', () => {
    test('applies the globe matrix except when rendering to terrain textures', () => {
        const {transform, tileID} = createTestContext();
        const renderOptions = createRenderOptions(transform, new MercatorProjection(), null);
        const projectionDataSpy = vi.spyOn(transform, 'getProjectionData');

        getProjectionData(renderOptions, tileID);
        renderOptions.isRenderingToTerrainTexture = true;
        getProjectionData(renderOptions, tileID, {aligned: true, applyTerrainMatrix: false});

        expect(projectionDataSpy).toHaveBeenCalledTimes(2);
        expect(projectionDataSpy).toHaveBeenNthCalledWith(1, {overscaledTileID: tileID, aligned: undefined, applyGlobeMatrix: true, applyTerrainMatrix: true});
        expect(projectionDataSpy).toHaveBeenNthCalledWith(2, {overscaledTileID: tileID, aligned: true, applyGlobeMatrix: false, applyTerrainMatrix: false});
    });

    test('uses terrain data outside terrain texture rendering', () => {
        const {transform, tileID, terrain, terrainData} = createTestContext();
        const renderOptions = createRenderOptions(transform, new MercatorProjection(), terrain);

        expect(getTerrainData(renderOptions, tileID)).toBe(terrainData);
        expect(terrain.getTerrainData).toHaveBeenCalledWith(tileID);
    });

    test('skips terrain data for Mercator tile textures', () => {
        const {transform, tileID, terrain} = createTestContext();
        const renderOptions = createRenderOptions(transform, new MercatorProjection(), terrain);
        renderOptions.isRenderingToTerrainTexture = true;

        expect(getTerrainData(renderOptions, tileID)).toBeNull();
        expect(terrain.getTerrainData).not.toHaveBeenCalled();
    });

    test('keeps terrain data for globe tile textures at the Mercator end of the transition', () => {
        const {transform, tileID, terrain, terrainData} = createTestContext();
        const projection = new GlobeProjection({type: 'mercator'}, {});
        const renderOptions = createRenderOptions(transform, projection, terrain);
        renderOptions.isRenderingToTerrainTexture = true;

        expect(getTerrainData(renderOptions, tileID)).toBe(terrainData);
    });

    test('has no terrain data without terrain', () => {
        const {transform, tileID} = createTestContext();
        const renderOptions = createRenderOptions(transform, new MercatorProjection(), null);

        expect(getTerrainData(renderOptions, tileID)).toBeNull();
    });
});
