import type {SymbolAnchor, TextJustify} from './shaping.ts';
import type {TextAnchor} from '../style/style_layer/variable_text_anchor.ts';

export function getAnchorAlignment(anchor: SymbolAnchor): {horizontalAlign: number; verticalAlign: number} {
    let horizontalAlign = 0.5, verticalAlign = 0.5;

    switch (anchor) {
        case 'right':
        case 'top-right':
        case 'bottom-right':
            horizontalAlign = 1;
            break;
        case 'left':
        case 'top-left':
        case 'bottom-left':
            horizontalAlign = 0;
            break;
    }

    switch (anchor) {
        case 'bottom':
        case 'bottom-right':
        case 'bottom-left':
            verticalAlign = 1;
            break;
        case 'top':
        case 'top-right':
        case 'top-left':
            verticalAlign = 0;
            break;
    }

    return {horizontalAlign, verticalAlign};
}

/**
 * Chooses the justification that matches the direction of the text anchor.
 */
export function getAnchorJustification(anchor: TextAnchor): TextJustify {
    switch (anchor) {
        case 'right':
        case 'top-right':
        case 'bottom-right':
            return 'right';
        case 'left':
        case 'top-left':
        case 'bottom-left':
            return 'left';
    }
    return 'center';
}
