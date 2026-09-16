import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    normalizeDiskText,
    shouldAskAboutDiskChange,
} from '../../src/service/markdown/externalChangeGuard.ts';

const utf8 = (text: string): Uint8Array => Buffer.from(text, 'utf8');

describe('normalizeDiskText', () => {

    it('passes plain utf-8 content through with LF endings', () => {
        assert.equal(normalizeDiskText(utf8('# hello\n\nworld')), '# hello\n\nworld');
        assert.equal(normalizeDiskText(utf8('ünïcødé 中文 🎉')), 'ünïcødé 中文 🎉');
        assert.equal(normalizeDiskText(utf8('')), '');
    });

    it('strips a UTF-8 BOM', () => {
        assert.equal(normalizeDiskText(utf8('\uFEFF# title')), '# title');
    });

    it('removes CR so disk CRLF matches the editor-normalized buffer', () => {
        assert.equal(normalizeDiskText(utf8('a\r\nb\rc\n')), 'a\nbc\n');
        assert.equal(normalizeDiskText(utf8('\uFEFFa\r\nb')), 'a\nb');
    });

    it('returns undefined for non-UTF-8 bytes (stay out of the way)', () => {
        // GBK "中文" — not valid UTF-8
        assert.equal(normalizeDiskText(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4])), undefined);
        // UTF-16LE BOM + payload — not valid UTF-8 either
        assert.equal(normalizeDiskText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00])), undefined);
        // lone continuation byte
        assert.equal(normalizeDiskText(Uint8Array.from([0x61, 0x80])), undefined);
    });

});

describe('shouldAskAboutDiskChange', () => {

    const base = {
        bufferTexts: ['# mine'],
        diskText: '# theirs',
        isDirty: true,
        acknowledgedDiskTexts: new Set<string>(),
    };

    it('asks when a dirty buffer diverges from disk', () => {
        assert.equal(shouldAskAboutDiskChange(base), true);
    });

    it('asks when the disk was emptied or the buffers are empty', () => {
        assert.equal(shouldAskAboutDiskChange({ ...base, diskText: '' }), true);
        assert.equal(shouldAskAboutDiskChange({ ...base, bufferTexts: [] }), true);
    });

    it('never asks for a clean document (VS Code auto-reloads it)', () => {
        assert.equal(shouldAskAboutDiskChange({ ...base, isDirty: false }), false);
    });

    it('never asks when disk matches any buffer form (echo of our own save)', () => {
        assert.equal(shouldAskAboutDiskChange({ ...base, diskText: '# mine' }), false);
        // typed-during-save window: document still holds the saved snapshot
        // while the webview content has advanced — not an external change.
        // Both orderings must hold: the echo may sit at any index.
        assert.equal(
            shouldAskAboutDiskChange({ ...base, bufferTexts: ['# saved', '# saved + typing'], diskText: '# saved' }),
            false,
        );
        assert.equal(
            shouldAskAboutDiskChange({ ...base, bufferTexts: ['# saved + typing', '# saved'], diskText: '# saved' }),
            false,
        );
    });

    it('asks only once per distinct disk content the user declined', () => {
        const acknowledged = new Set(['# theirs']);
        assert.equal(shouldAskAboutDiskChange({ ...base, acknowledgedDiskTexts: acknowledged }), false);
        assert.equal(
            shouldAskAboutDiskChange({ ...base, diskText: '# third writer', acknowledgedDiskTexts: acknowledged }),
            true,
        );
    });

    it('never asks when the echo guard already applies, even if acknowledged', () => {
        const acknowledged = new Set(['# mine']);
        assert.equal(
            shouldAskAboutDiskChange({ ...base, diskText: '# mine', acknowledgedDiskTexts: acknowledged }),
            false,
        );
    });

});
