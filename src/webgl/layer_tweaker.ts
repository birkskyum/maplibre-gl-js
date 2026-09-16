import type {DrawableCollection} from './drawable.ts';
import type {UniformBindings} from './uniform_binding.ts';
import type {Painter} from '../render/painter.ts';
import type {RenderContext} from '../render/render_context.ts';

/** Updates a layer's paint values and texture bindings before drawing. */
export type LayerTweaker<Us extends UniformBindings> = (
    drawables: DrawableCollection<Us>,
    painter: Painter,
    renderContext: RenderContext
) => void;
