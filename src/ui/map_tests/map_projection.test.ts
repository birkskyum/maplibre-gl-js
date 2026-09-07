import {beforeEach, afterEach, describe, test, expect} from 'vitest';
import {fakeServer, type FakeServer} from 'nise';
import {createMap, beforeMapTest} from '../../util/test/util.ts';
import {GlobeControl} from '../control/globe_control.ts';
import type {ProjectionSpecification, StyleSpecification} from '@maplibre/maplibre-gl-style-spec';

let server: FakeServer;

beforeEach(() => {
    beforeMapTest();
    global.fetch = null;
    server = fakeServer.create();
    server.autoRespond = true;
});

afterEach(() => {
    server.restore();
});

describe('projection constructor option', () => {
    test('overrides the style projection without changing the supplied style', async () => {
        const style: StyleSpecification = {version: 8, sources: {}, layers: [], projection: {type: 'mercator'}};
        const map = createMap({style, projection: {type: 'globe'}, center: [65.7, 85], zoom: 0});

        await map.once('style.load');

        expect(map.getProjection()).toEqual({type: 'globe'});
        expect(map.getStyle().projection).toEqual({type: 'globe'});
        expect(style.projection).toEqual({type: 'mercator'});
        expect(map.getCenter().toArray()).toEqual([65.7, 85]);
        expect(map.getZoom()).toBe(0);
        map.remove();
    });

    test('applies a projection expression before a URL style can constrain the globe camera', async () => {
        server.respondWith('style.json', JSON.stringify({version: 8, sources: {}, layers: []}));
        const projection: ProjectionSpecification = {
            type: ['interpolate', ['linear'], ['zoom'], 5, 'vertical-perspective', 7, 'mercator']
        };
        const map = createMap({style: 'style.json', projection, center: [65.7, 85], zoom: 0});

        await map.once('style.load');

        expect(map.getProjection()).toEqual(projection);
        expect(map.getStyle().projection).toEqual(projection);
        expect(map.getStyleUrl()).toBe('style.json');
        expect(map.getCenter().toArray()).toEqual([65.7, 85]);
        expect(map.getZoom()).toBe(0);
        map.remove();
    });

    test('uses the style projection when the constructor option is omitted', async () => {
        const map = createMap({style: {version: 8, sources: {}, layers: [], projection: {type: 'globe'}}});

        await map.once('style.load');

        expect(map.getProjection()).toEqual({type: 'globe'});
        map.setStyle({version: 8, sources: {}, layers: [], projection: {type: 'mercator'}});
        expect(map.getProjection()).toEqual({type: 'mercator'});
        map.remove();
    });

    test('validates the constructor projection when the style loads', async () => {
        const map = createMap({projection: {type: 7 as unknown as ProjectionSpecification['type']}});

        const {error} = await map.once('error');

        expect(error.message).toContain('invalid type "number"');
        map.remove();
    });

    test.each([true, false])('preserves the current projection across style changes with diff: %s', async (diff) => {
        const map = createMap({projection: {type: 'globe'}});
        map.addControl(new GlobeControl());
        await map.once('style.load');
        const style: StyleSpecification = {
            version: 8,
            sources: {},
            layers: [{id: 'background', type: 'background'}],
            projection: {type: 'mercator'}
        };
        const styleLoaded = map.once('style.load');

        map.setStyle(style, {
            diff,
            transformStyle: (_, next) => ({...next, name: 'transformed', projection: {type: 'mercator'}})
        });
        await styleLoaded;

        expect(map.getProjection()).toEqual({type: 'globe'});
        expect(map.getStyle().projection).toEqual({type: 'globe'});
        expect(map.getStyle().name).toBe('transformed');
        expect(map.getLayer('background')).toBeDefined();
        expect(style.projection).toEqual({type: 'mercator'});

        const button = map.getContainer().querySelector<HTMLButtonElement>('.maplibregl-ctrl-globe-enabled');
        expect(button).not.toBeNull();
        button.click();
        expect(map.getProjection()).toEqual({type: 'mercator'});
        const nextStyleLoaded = map.once('style.load');
        map.setStyle({version: 8, sources: {}, layers: [], projection: {type: 'globe'}}, {diff});
        await nextStyleLoaded;

        expect(map.getProjection()).toEqual({type: 'mercator'});
        expect(map.getStyle().projection).toEqual({type: 'mercator'});
        expect(button.classList).toContain('maplibregl-ctrl-globe');
        map.remove();
    });

    test('retains the projection when a style is added later or removed and replaced', async () => {
        const map = createMap({deleteStyle: true, projection: {type: 'globe'}});
        expect(map.getProjection()).toEqual({type: 'globe'});

        map.setStyle({version: 8, sources: {}, layers: []});
        await map.once('style.load');
        expect(map.getStyle().projection).toEqual({type: 'globe'});

        map.setStyle(null);
        map.setStyle({version: 8, sources: {}, layers: [], projection: {type: 'mercator'}});
        await map.once('style.load');
        expect(map.getStyle().projection).toEqual({type: 'globe'});
        map.remove();
    });

    test('applies the projection to an empty style initialized by adding a layer', () => {
        const map = createMap({deleteStyle: true, projection: {type: 'globe'}});

        map.addLayer({id: 'background', type: 'background'});

        expect(map.getStyle().projection).toEqual({type: 'globe'});
        expect(map.getLayer('background')).toBeDefined();
        map.remove();
    });

    test('retains camera defaults from the style when only the projection is supplied', async () => {
        const map = createMap({
            projection: {type: 'globe'},
            style: {version: 8, sources: {}, layers: [], center: [10, 45], zoom: 4, bearing: 20, pitch: 30, roll: 10}
        });

        await map.once('style.load');

        expect(map.getCenter().toArray()).toEqual([10, 45]);
        expect(map.getZoom()).toBe(4);
        expect(map.getBearing()).toBeCloseTo(20);
        expect(map.getPitch()).toBeCloseTo(30);
        expect(map.getRoll()).toBeCloseTo(10);
        map.remove();
    });
});
