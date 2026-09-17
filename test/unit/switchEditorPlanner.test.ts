import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planSwitchEditor } from '../../src/service/markdown/switchEditorPlanner.ts';

const ORIGINAL = 'file:///d:/notes/a.md';
const MODIFIED = 'file:///d:/notes/b.md';

describe('planSwitchEditor', () => {
    it('returns a diff plan when the active tab shows a text diff', () => {
        const plan = planSwitchEditor({
            activeTabDiff: { original: ORIGINAL, modified: MODIFIED, label: 'a.md ↔ b.md' },
        });
        assert.deepEqual(plan, {
            action: 'diff',
            original: ORIGINAL,
            modified: MODIFIED,
            label: 'a.md ↔ b.md',
        });
    });

    it('prefers the diff tab over the active text editor', () => {
        const plan = planSwitchEditor({
            activeTabDiff: { original: ORIGINAL, modified: MODIFIED, label: 'a.md ↔ b.md' },
            activeTextEditorUri: 'file:///d:/notes/c.md',
            commandUri: 'file:///d:/notes/c.md',
        });
        assert.equal(plan?.action, 'diff');
    });

    it('switches a focused text editor to the markdown viewer', () => {
        const plan = planSwitchEditor({
            commandUri: ORIGINAL,
            activeTextEditorUri: ORIGINAL,
        });
        assert.deepEqual(plan, {
            action: 'openWith',
            uri: ORIGINAL,
            viewType: 'cweijan.markdownViewer',
        });
    });

    it('falls back to the text editor uri when the menu uri is absent (keybinding path)', () => {
        const plan = planSwitchEditor({ activeTextEditorUri: ORIGINAL });
        assert.deepEqual(plan, {
            action: 'openWith',
            uri: ORIGINAL,
            viewType: 'cweijan.markdownViewer',
        });
    });

    it('switches a custom editor back to the default text editor', () => {
        const plan = planSwitchEditor({ commandUri: ORIGINAL });
        assert.deepEqual(plan, {
            action: 'openWith',
            uri: ORIGINAL,
            viewType: 'default',
        });
    });

    it('returns undefined when no context is available', () => {
        assert.equal(planSwitchEditor({}), undefined);
    });
});
