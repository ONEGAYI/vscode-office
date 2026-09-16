import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    extractUriScheme,
    isWebviewCommandAllowed,
    isOpenExternalLinkAllowed,
    sanitizeImageExtension,
} from '../../src/service/markdown/webviewInputValidation.ts';

describe('sanitizeImageExtension', () => {

    it('normalizes plain extensions', () => {
        assert.equal(sanitizeImageExtension('png'), 'png');
        assert.equal(sanitizeImageExtension('PNG'), 'png');
        assert.equal(sanitizeImageExtension('  jpg '), 'jpg');
        assert.equal(sanitizeImageExtension('jpeg'), 'jpeg');
        assert.equal(sanitizeImageExtension('webp'), 'webp');
    });

    it('rejects path traversal payloads', () => {
        assert.equal(sanitizeImageExtension('../../etc/passwd'), undefined);
        assert.equal(sanitizeImageExtension('png/../../x'), undefined);
        assert.equal(sanitizeImageExtension('..\\..\\x'), undefined);
        assert.equal(sanitizeImageExtension('..'), undefined);
        assert.equal(sanitizeImageExtension('.'), undefined);
        assert.equal(sanitizeImageExtension('png\\x'), undefined);
    });

    it('rejects windows drive letters and absolute paths', () => {
        assert.equal(sanitizeImageExtension('c:'), undefined);
        assert.equal(sanitizeImageExtension('C:\\temp'), undefined);
        assert.equal(sanitizeImageExtension('/tmp'), undefined);
    });

    it('normalizes surrounding whitespace away', () => {
        assert.equal(sanitizeImageExtension('png\n'), 'png');
        assert.equal(sanitizeImageExtension('png\t'), 'png');
    });

    it('rejects dots even between plain words', () => {
        assert.equal(sanitizeImageExtension('png.exe'), undefined);
        assert.equal(sanitizeImageExtension('tar.gz'), undefined);
    });

    it('accepts the length boundary', () => {
        assert.equal(sanitizeImageExtension('a'.repeat(10)), 'a'.repeat(10));
        assert.equal(sanitizeImageExtension('a'.repeat(11)), undefined);
    });

    it('rejects control characters and oversized values', () => {
        assert.equal(sanitizeImageExtension('png\0'), undefined);
        assert.equal(sanitizeImageExtension('a'.repeat(11)), undefined);
    });

    it('rejects non-string input', () => {
        assert.equal(sanitizeImageExtension(undefined), undefined);
        assert.equal(sanitizeImageExtension(null), undefined);
        assert.equal(sanitizeImageExtension(42 as unknown), undefined);
        assert.equal(sanitizeImageExtension({ ext: 'png' } as unknown), undefined);
        assert.equal(sanitizeImageExtension(''), undefined);
    });

});

describe('isOpenExternalLinkAllowed', () => {

    it('allows user-browsable schemes', () => {
        assert.equal(isOpenExternalLinkAllowed('https://example.com/a?b=c#d'), true);
        assert.equal(isOpenExternalLinkAllowed('http://example.com'), true);
        assert.equal(isOpenExternalLinkAllowed('mailto:someone@example.com'), true);
        assert.equal(isOpenExternalLinkAllowed('HTTPS://EXAMPLE.COM'), true);
        assert.equal(isOpenExternalLinkAllowed('  https://example.com  '), true);
    });

    it('drops os-handler pivot schemes', () => {
        assert.equal(isOpenExternalLinkAllowed('file:///D:/secrets.txt'), false);
        assert.equal(isOpenExternalLinkAllowed('vscode://extension/some-ext'), false);
        assert.equal(isOpenExternalLinkAllowed('vscode-webview-resource://x'), false);
        assert.equal(isOpenExternalLinkAllowed('command:workbench.action.toggleDevTools'), false);
        assert.equal(isOpenExternalLinkAllowed('javascript:alert(1)'), false);
        assert.equal(isOpenExternalLinkAllowed('data:text/html,hi'), false);
        assert.equal(isOpenExternalLinkAllowed('ftp://example.com'), false);
        assert.equal(isOpenExternalLinkAllowed('smb://host/share'), false);
    });

    it('drops scheme-less and malformed values', () => {
        assert.equal(isOpenExternalLinkAllowed('relative/path.md'), false);
        assert.equal(isOpenExternalLinkAllowed('readme.md'), false);
        assert.equal(isOpenExternalLinkAllowed('https'), false);
        assert.equal(isOpenExternalLinkAllowed('   '), false);
        assert.equal(isOpenExternalLinkAllowed(''), false);
        assert.equal(isOpenExternalLinkAllowed(undefined as unknown), false);
        assert.equal(isOpenExternalLinkAllowed(123 as unknown), false);
    });

});

describe('extractUriScheme', () => {

    it('extracts and normalizes schemes', () => {
        assert.equal(extractUriScheme('https://example.com'), 'https');
        assert.equal(extractUriScheme('MAILTO:x@y.com'), 'mailto');
        assert.equal(extractUriScheme('  ftp://host  '), 'ftp');
        assert.equal(extractUriScheme('a+b-c.d:rest'), 'a+b-c.d');
    });

    it('returns undefined for scheme-less and malformed values', () => {
        assert.equal(extractUriScheme('readme.md'), undefined);
        assert.equal(extractUriScheme(''), undefined);
        assert.equal(extractUriScheme('   '), undefined);
        assert.equal(extractUriScheme(null as unknown), undefined);
    });

});

describe('isWebviewCommandAllowed', () => {

    it('allows the paste command the context menu sends', () => {
        assert.equal(isWebviewCommandAllowed('office.markdown.paste'), true);
    });

    it('rejects everything else', () => {
        assert.equal(isWebviewCommandAllowed('workbench.action.toggleDevTools'), false);
        assert.equal(isWebviewCommandAllowed(''), false);
        assert.equal(isWebviewCommandAllowed(undefined as unknown), false);
        assert.equal(isWebviewCommandAllowed({ id: 'office.markdown.paste' } as unknown), false);
    });

});
