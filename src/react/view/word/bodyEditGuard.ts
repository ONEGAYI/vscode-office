import { Plugin, Selection } from 'prosemirror-state';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

type BodyView = Pick<EditorView, 'state' | 'dispatch' | 'focus'>;

/** Move a whole body block in one transaction, preserving identity and undo. */
export function moveBodyBlock(view: BodyView, direction: -1 | 1) {
    const { state } = view;
    const index = state.selection.$from.index(0), target = index + direction;
    if (target < 0 || target >= state.doc.childCount) return false;
    const blocks: ProseMirrorNode[] = [];
    state.doc.forEach(node => blocks.push(node));
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    const tr = state.tr.replaceWith(0, state.doc.content.size, blocks);
    const pos = blocks.slice(0, target).reduce((sum, node) => sum + node.nodeSize, 0);
    tr.setSelection(Selection.near(tr.doc.resolve(pos + 1)));
    view.dispatch(tr.scrollIntoView()); view.focus();
    return true;
}

export function insertBodyParagraph(view: BodyView, side: -1 | 1) {
    const { state } = view;
    const index = state.selection.$from.index(0);
    let pos = 0;
    for (let i = 0; i < index; i++) pos += state.doc.child(i).nodeSize;
    if (side === 1) pos += state.doc.child(index).nodeSize;
    const paragraph = state.schema.nodes.paragraph.createAndFill();
    if (!paragraph) return false;
    const tr = state.tr.insert(pos, paragraph);
    tr.setSelection(Selection.near(tr.doc.resolve(pos + 1)));
    view.dispatch(tr.scrollIntoView()); view.focus();
    return true;
}

/** Protect opaque block contents, not their positions or the surrounding paragraph count. */
export function createBodyEditGuard(editable: Set<string>, onBlocked: () => void) {
    let initial: ProseMirrorNode[] = [];
    const signature = (node: ProseMirrorNode) => JSON.stringify(node.type.name === 'paragraph'
        ? { type: 'paragraph', paraId: node.attrs.paraId, content: node.content.toJSON() } : node.toJSON());
    function simple(node: ProseMirrorNode) {
        let supported = node.type.name === 'paragraph';
        node.forEach(child => {
            if (!child.isText && !['hardBreak', 'tab'].includes(child.type.name)) supported = false;
            if (child.marks.some(mark => /link|comment|revision|change|insertion|deletion/i.test(mark.type.name))) supported = false;
        });
        return supported;
    }
    return new Plugin({
        state: {
            init(_config, state) { initial = []; state.doc.forEach(node => initial.push(node)); return null; },
            apply() { return null; },
        },
        filterTransaction(transaction, state) {
            if (!transaction.docChanged) return true;
            try {
                const protectedBlocks = initial.filter(node => node.type.name !== 'paragraph' || !editable.has(node.attrs.paraId));
                const remaining = protectedBlocks.map(signature);
                const protectedIds = new Set(protectedBlocks.filter(n => n.type.name === 'paragraph').map(n => n.attrs.paraId));
                let valid = JSON.stringify(state.doc.attrs) === JSON.stringify(transaction.doc.attrs);
                transaction.doc.forEach(node => {
                    const index = remaining.indexOf(signature(node));
                    if (index !== -1) remaining.splice(index, 1);
                    else if (!simple(node) || protectedIds.has(node.attrs.paraId)) valid = false;
                });
                if (valid && remaining.length === 0) return true;
            } catch { /* Fail closed for unsupported content. */ }
            onBlocked();
            return false;
        },
    });
}
