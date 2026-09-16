import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
    collectPanelBufferTexts,
    endDiskChangePrompt,
    getSharedAcknowledgedDiskTexts,
    registerDiskChangePanel,
    resetDiskChangeCoordinatorForTest,
    shouldNotifyDeletedOnce,
    clearDeletedNotified,
    tryBeginDiskChangePrompt,
} from '../../src/service/markdown/diskChangeCoordinator.ts';

const URI_A = 'file:///d:/notes/a.md';
const URI_B = 'file:///d:/notes/b.md';

describe('diskChangeCoordinator panel registry', () => {
    beforeEach(() => resetDiskChangeCoordinatorForTest());

    it('collects the content snapshot of a single panel', () => {
        let content = 'hello';
        const dispose = registerDiskChangePanel(URI_A, { getContent: () => content });
        assert.deepEqual(collectPanelBufferTexts(URI_A), ['hello']);
        dispose();
    });

    it('collects snapshots of all live panels in registration order', () => {
        const disposeFirst = registerDiskChangePanel(URI_A, { getContent: () => 'one' });
        const disposeSecond = registerDiskChangePanel(URI_A, { getContent: () => 'two' });
        assert.deepEqual(collectPanelBufferTexts(URI_A), ['one', 'two']);
        disposeFirst();
        assert.deepEqual(collectPanelBufferTexts(URI_A), ['two']);
        disposeSecond();
    });

    it('reads the live value on every collect (getter, not snapshot)', () => {
        let content = 'before';
        const dispose = registerDiskChangePanel(URI_A, { getContent: () => content });
        content = 'after';
        assert.deepEqual(collectPanelBufferTexts(URI_A), ['after']);
        dispose();
    });

    it('isolates panels per uri', () => {
        const dispose_a = registerDiskChangePanel(URI_A, { getContent: () => 'a' });
        registerDiskChangePanel(URI_B, { getContent: () => 'b' });
        assert.deepEqual(collectPanelBufferTexts(URI_A), ['a']);
        dispose_a();
    });

    it('drops uri state once every panel is disposed', () => {
        const acknowledgedBefore = getSharedAcknowledgedDiskTexts(URI_A);
        const dispose = registerDiskChangePanel(URI_A, { getContent: () => 'x' });
        dispose();
        // a fresh state must have been created: the old shared set is orphaned
        assert.notEqual(getSharedAcknowledgedDiskTexts(URI_A), acknowledgedBefore);
    });
});

describe('diskChangeCoordinator prompt serialization', () => {
    beforeEach(() => resetDiskChangeCoordinatorForTest());

    it('grants the prompt slot to exactly one caller until ended', () => {
        assert.equal(tryBeginDiskChangePrompt(URI_A), true);
        assert.equal(tryBeginDiskChangePrompt(URI_A), false);
        endDiskChangePrompt(URI_A);
        assert.equal(tryBeginDiskChangePrompt(URI_A), true);
        endDiskChangePrompt(URI_A);
    });

    it('serializes per uri, not globally', () => {
        assert.equal(tryBeginDiskChangePrompt(URI_A), true);
        assert.equal(tryBeginDiskChangePrompt(URI_B), true);
        endDiskChangePrompt(URI_A);
        endDiskChangePrompt(URI_B);
    });

    it('keeps the prompt slot claimed until ended even if panels dispose', () => {
        // the pending prompt is a window-level message that outlives its
        // panel; sibling panels must stay silent until it is answered
        const dispose = registerDiskChangePanel(URI_A, { getContent: () => 'x' });
        assert.equal(tryBeginDiskChangePrompt(URI_A), true);
        dispose();
        assert.equal(tryBeginDiskChangePrompt(URI_A), false);
        endDiskChangePrompt(URI_A);
        assert.equal(tryBeginDiskChangePrompt(URI_A), true);
        endDiskChangePrompt(URI_A);
    });

    it('keeps the shared state (incl. acknowledged set) alive while a prompt is pending', () => {
        // a decision answered after the prompting panel disposed must
        // still write into the state future panels will read
        const dispose = registerDiskChangePanel(URI_A, { getContent: () => 'x' });
        const sharedSet = getSharedAcknowledgedDiskTexts(URI_A);
        assert.equal(tryBeginDiskChangePrompt(URI_A), true);
        dispose();
        sharedSet.add('disk-text');
        assert.equal(getSharedAcknowledgedDiskTexts(URI_A), sharedSet);
        endDiskChangePrompt(URI_A);
        // state collected after the prompt ends and no panels remain
        assert.notEqual(getSharedAcknowledgedDiskTexts(URI_A), sharedSet);
    });
});

describe('diskChangeCoordinator shared acknowledgement', () => {
    beforeEach(() => resetDiskChangeCoordinatorForTest());

    it('returns the same set for the same uri', () => {
        const dispose = registerDiskChangePanel(URI_A, { getContent: () => 'x' });
        assert.equal(getSharedAcknowledgedDiskTexts(URI_A), getSharedAcknowledgedDiskTexts(URI_A));
        dispose();
    });

    it('returns distinct sets for distinct uris', () => {
        const dispose_a = registerDiskChangePanel(URI_A, { getContent: () => 'a' });
        const dispose_b = registerDiskChangePanel(URI_B, { getContent: () => 'b' });
        const setA = getSharedAcknowledgedDiskTexts(URI_A);
        setA.add('disk-text-a');
        assert.equal(getSharedAcknowledgedDiskTexts(URI_B).has('disk-text-a'), false);
        dispose_a();
        dispose_b();
    });
});

describe('diskChangeCoordinator deleted-notification latch', () => {
    beforeEach(() => resetDiskChangeCoordinatorForTest());

    it('notifies deleted exactly once until cleared', () => {
        const dispose = registerDiskChangePanel(URI_A, { getContent: () => 'x' });
        assert.equal(shouldNotifyDeletedOnce(URI_A), true);
        assert.equal(shouldNotifyDeletedOnce(URI_A), false);
        clearDeletedNotified(URI_A);
        assert.equal(shouldNotifyDeletedOnce(URI_A), true);
        dispose();
    });
});
