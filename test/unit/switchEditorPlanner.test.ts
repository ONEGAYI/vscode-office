import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    parseDiffLabel,
    planSwitchEditor,
    resolveUnknownDiffSides,
} from '../../src/service/markdown/switchEditorPlanner.ts';

const ORIGINAL = 'file:///d:/notes/a.md';
const MODIFIED = 'file:///d:/notes/b.md';

describe('planSwitchEditor', () => {
    it('returns an editor comparison plan when the active tab shows a text diff', () => {
        const plan = planSwitchEditor({
            activeTabDiff: { original: ORIGINAL, modified: MODIFIED, label: 'a.md ↔ b.md' },
        });
        assert.deepEqual(plan, {
            action: 'diff',
            viewType: 'cweijan.markdownViewer',
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

describe('parseDiffLabel', () => {
    it('splits a custom-editor diff tab label into both sides', () => {
        assert.deepEqual(parseDiffLabel('b.md ↔ a.md'), { left: 'b.md', right: 'a.md' });
    });

    it('returns undefined when the label is not a diff pair', () => {
        assert.equal(parseDiffLabel('a.md'), undefined);
        assert.equal(parseDiffLabel(''), undefined);
    });
});

describe('resolveUnknownDiffSides', () => {
    const tabs = [
        { label: 'b.md', uri: 'file:///d:/notes/b.md' },
        { label: 'a.md', uri: 'file:///d:/notes/a.md' },
    ];

    it('resolves a diff without a title URI using its still-open documents', () => {
        assert.deepEqual(resolveUnknownDiffSides('b.md ↔ a.md', undefined, tabs), {
            original: MODIFIED, modified: ORIGINAL,
        });
    });

    it('resolves both sides when the command uri is the right side', () => {
        const sides = resolveUnknownDiffSides('b.md ↔ a.md', 'file:///d:/notes/a.md', tabs);
        assert.deepEqual(sides, { original: 'file:///d:/notes/b.md', modified: 'file:///d:/notes/a.md' });
    });

    it('resolves both sides when the command uri is the left side', () => {
        const sides = resolveUnknownDiffSides('b.md ↔ a.md', 'file:///d:/notes/b.md', tabs);
        assert.deepEqual(sides, { original: 'file:///d:/notes/b.md', modified: 'file:///d:/notes/a.md' });
    });

    it('does not guess even if one duplicate filename shares the command folder', () => {
        const sides = resolveUnknownDiffSides('b.md ↔ a.md', 'file:///d:/other/a.md', [
            { label: 'b.md', uri: 'file:///d:/notes/b.md' },
            { label: 'b.md', uri: 'file:///d:/other/b.md' },
        ]);
        assert.equal(sides, undefined);
    });

    it('returns undefined when no open tab matches the other side', () => {
        assert.equal(
            resolveUnknownDiffSides('b.md ↔ a.md', 'file:///d:/notes/a.md', [
                { label: 'a.md', uri: 'file:///d:/notes/a.md' },
            ]),
            undefined,
        );
    });

    it('returns undefined when the command uri matches neither side', () => {
        assert.equal(
            resolveUnknownDiffSides('b.md ↔ a.md', 'file:///d:/notes/c.md', tabs),
            undefined,
        );
    });

    it('returns undefined for a non-diff label', () => {
        assert.equal(
            resolveUnknownDiffSides('a.md', 'file:///d:/notes/a.md', tabs),
            undefined,
        );
    });

    it('does not guess between duplicate filenames in different folders', () => {
        assert.equal(resolveUnknownDiffSides('b.md ↔ a.md', 'file:///d:/third/a.md', [
            ...tabs, { label: 'b.md', uri: 'file:///d:/other/b.md' },
        ]), undefined);
    });

    it('does not compare a document to itself when both labels are identical', () => {
        assert.equal(resolveUnknownDiffSides('a.md ↔ a.md', ORIGINAL, tabs), undefined);
    });

    it('decodes URI filenames, including spaces and Unicode', () => {
        assert.deepEqual(resolveUnknownDiffSides('before.md ↔ 笔记 a.md', 'file:///d:/notes/%E7%AC%94%E8%AE%B0%20a.md', [
            { label: '', uri: 'file:///d:/notes/before.md' },
        ]), { original: 'file:///d:/notes/before.md', modified: 'file:///d:/notes/%E7%AC%94%E8%AE%B0%20a.md' });
    });
});
