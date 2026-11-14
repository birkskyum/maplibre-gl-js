import {describe, test, expect, vi} from 'vitest';
import {OverscaledTileID} from '../../tile/tile_id.ts';
import {TileManager} from '../../tile/tile_manager.ts';
import {Tile} from '../../tile/tile.ts';
import {Painter} from '../../render/painter.ts';
import {FrameRenderContext} from '../../render/frame_render_context.ts';
import {Program} from '../program.ts';
import {LineStyleLayer} from '../../style/style_layer/line_style_layer.ts';
import {drawLine} from './draw_line.ts';
import {createFrameRenderData, createTestCamera} from '../../util/test/util.ts';

import type {LineBucket} from '../../data/bucket/line_bucket.ts';
import type {ProgramConfiguration} from '../../data/program_configuration.ts';
import type {LineLayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import type {ZoomHistory} from '../../style/zoom_history.ts';

vi.mock(import('../../render/painter'));
vi.mock(import('../program'));
vi.mock(import('../../tile/tile_manager'));
vi.mock(import('../../tile/tile'));

describe('drawLine', () => {
    test('looks up the dashes of a constant line-dasharray once for all tiles of a layer', () => {
        const painterMock = constructMockPainter();
        const frameRenderContext = constructFrameRenderContext(painterMock);
        const layer = constructMockLayer();
        const programMock = new Program(null, null, null, null, null, null, null, null);
        vi.spyOn(frameRenderContext, 'useProgram').mockReturnValue(programMock);
        const programConfiguration = constructMockProgramConfiguration();
        const tiles = [new OverscaledTileID(1, 0, 1, 0, 0), new OverscaledTileID(1, 0, 1, 1, 0), new OverscaledTileID(1, 0, 1, 0, 1)]
            .map((tileID) => constructMockTile(tileID, programConfiguration));
        const tileManagerMock = new TileManager(null, null, null);
        (vi.mocked(tileManagerMock.getTile)).mockImplementation((tileID) => tiles.find((tile) => tile.tileID === tileID));

        drawLine(painterMock, tileManagerMock, layer, tiles.map((tile) => tile.tileID), frameRenderContext);

        expect(programMock.draw).toHaveBeenCalledTimes(3);
        expect(programConfiguration.setConstantDashPositions).toHaveBeenCalledTimes(3);
        expect(painterMock.lineAtlas.getDash).toHaveBeenCalledTimes(2);
    });

    test('does not look up dashes when no tile has a bucket', () => {
        const painterMock = constructMockPainter();
        const frameRenderContext = constructFrameRenderContext(painterMock);
        const layer = constructMockLayer();
        const programMock = new Program(null, null, null, null, null, null, null, null);
        vi.spyOn(frameRenderContext, 'useProgram').mockReturnValue(programMock);
        const tile = constructMockTile(new OverscaledTileID(1, 0, 1, 0, 0), null);
        const tileManagerMock = new TileManager(null, null, null);
        (vi.mocked(tileManagerMock.getTile)).mockReturnValue(tile);

        drawLine(painterMock, tileManagerMock, layer, [tile.tileID], frameRenderContext);

        expect(programMock.draw).not.toHaveBeenCalled();
        expect(painterMock.lineAtlas.getDash).not.toHaveBeenCalled();
    });

    function constructMockLayer(): LineStyleLayer {
        const layerSpec = {
            id: 'mock-layer',
            source: 'empty-source',
            type: 'line',
            layout: {},
            paint: {
                'line-dasharray': [2, 2]
            }
        } as LineLayerSpecification;
        const layer = new LineStyleLayer(layerSpec, {});
        layer.getCrossfadeParameters = () => ({fromScale: 1, toScale: 1, t: 1});
        layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        return layer;
    }

    function constructMockPainter(): Painter {
        const painterMock = new Painter(null);
        painterMock.context = {
            gl: {},
            activeTexture: {
                set: () => {}
            },
            program: {
                get: () => null
            }
        } as any;
        painterMock.lineAtlas = {
            width: 256,
            height: 256,
            getDash: vi.fn(() => ({y: 0, height: 1, width: 4})),
            bind: () => {}
        } as any;
        return painterMock;
    }

    function constructFrameRenderContext(painter: Painter): FrameRenderContext {
        const {projectedCamera, context} = createTestCamera({width: 512, height: 512});
        return new FrameRenderContext({projectedCamera, worldCoordinateHelper: context.worldCoordinateHelper, terrain: null, data: createFrameRenderData(), context: painter.context, programCache: null, currentPass: 'translucent', projection: null});
    }

    function constructMockProgramConfiguration(): ProgramConfiguration {
        return {
            updatePaintBuffers: () => {},
            setConstantDashPositions: vi.fn()
        } as any;
    }

    function constructMockTile(tileID: OverscaledTileID, programConfiguration: ProgramConfiguration | null): Tile {
        const tile = new Tile(tileID, 512);
        tile.tileID = tileID;
        tile.tileSize = 512;
        const bucket = programConfiguration ? {
            programConfigurations: {
                get: () => programConfiguration
            },
            lineClipsArray: []
        } as any as LineBucket : undefined;
        (vi.mocked(tile.getBucket)).mockReturnValue(bucket);
        return tile;
    }
});
