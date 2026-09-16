import {expect, test, vi} from 'vitest';
import {DrawableCollection} from './drawable.ts';
import {Mesh} from '../render/mesh.ts';

import type {Program} from './program.ts';
import type {UniformBindings} from './uniform_binding.ts';

const TRIANGLES = 0x0004;

test('keeps required drawables without drawing them and removes tiles that leave the cover', () => {
    const program = {draw: vi.fn()} as unknown as Program<UniformBindings>;
    const mesh = new Mesh(null, null, null);
    const collection = new DrawableCollection();

    collection.get('first', program, mesh, 'layer', TRIANGLES);
    const second = collection.get('second', program, mesh, 'layer', TRIANGLES);
    collection.endUpdate();
    expect([...collection.entries.keys()]).toEqual(['first', 'second']);

    const reusedSecond = collection.get('second', program, mesh, 'layer', TRIANGLES);
    expect(reusedSecond).toBe(second);
    collection.endUpdate();
    expect([...collection.entries.keys()]).toEqual(['second']);

    collection.endUpdate();
    expect(collection.entries.size).toBe(0);
    expect(program.draw).not.toHaveBeenCalled();
});
