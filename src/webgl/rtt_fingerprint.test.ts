import {describe, test, expect} from 'vitest';
import {RTTFingerprint} from './rtt_fingerprint.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';

describe('RTTFingerprint', () => {
    const a = new OverscaledTileID(3, 0, 2, 1, 2);
    const b = new OverscaledTileID(3, 0, 2, 2, 2);
    const layers = 'water,roads';

    test('no difference for the same tiles, revision, zoom and layers, in any tile order', () => {
        const fingerprint = new RTTFingerprint([a, b], 0, 10, layers, 0);

        expect(fingerprint.difference(new RTTFingerprint([b, a], 0, 10, layers, 0))).toBe('none');
    });

    test('a zoom change with the same layers is a zoom difference', () => {
        const fingerprint = new RTTFingerprint([a, b], 0, 10, layers, 0);

        expect(fingerprint.difference(new RTTFingerprint([a, b], 0, 11, layers, 0))).toBe('zoom');
    });

    test('other source tiles are a source tile difference', () => {
        const fingerprint = new RTTFingerprint([a, b], 0, 10, layers, 0);

        expect(fingerprint.difference(new RTTFingerprint([a], 0, 10, layers, 0))).toBe('sourceTiles');
    });

    test('a zoom change that changes the visible layers is a visible layer difference', () => {
        const fingerprint = new RTTFingerprint([a, b], 0, 10, layers, 0);

        expect(fingerprint.difference(new RTTFingerprint([a, b], 0, 11, 'water', 0))).toBe('visibleLayers');
    });

    test('another bearing is a bearing difference, which outranks a visible layer difference', () => {
        const fingerprint = new RTTFingerprint([a, b], 0, 10, layers, 0);

        expect(fingerprint.difference(new RTTFingerprint([a, b], 0, 11, 'water', 0.5))).toBe('bearing');
    });

    test('a revision change outranks every other difference, and a missing fingerprint counts as one', () => {
        const fingerprint = new RTTFingerprint([a, b], 0, 10, layers, 0);

        expect(fingerprint.difference(new RTTFingerprint([a], 1, 11, 'water', 0))).toBe('revision');
        expect(fingerprint.difference(undefined)).toBe('revision');
    });
});
