import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    extractUriScheme,
    isWebviewCommandAllowed,
    isOpenExternalLinkAllowed,
    sanitizeDiagramExportPayload,
    sanitizeDiagramSvgContent,
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

describe('sanitizeDiagramExportPayload', () => {

    it('passes a valid inline svg through as svg mode', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
        assert.deepEqual(
            sanitizeDiagramExportPayload({ svg, fileName: 'flow.svg' }),
            { mode: 'svg', svg, fileName: 'flow.svg' },
        );
    });

    it('accepts svg with leading whitespace and xml prolog', () => {
        const svg = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>';
        assert.deepEqual(
            sanitizeDiagramExportPayload({ svg: '  ' + svg, fileName: 'a.svg' }),
            { mode: 'svg', svg: '  ' + svg, fileName: 'a.svg' },
        );
    });

    it('normalizes the file name: strips paths, foreign chars and enforces .svg', () => {
        assert.equal(
            sanitizeDiagramExportPayload({ svg: '<svg/>', fileName: '..\\..\\evil.svg' })?.fileName,
            'evil.svg',
        );
        assert.equal(
            sanitizeDiagramExportPayload({ svg: '<svg/>', fileName: '/tmp/x<>.svg' })?.fileName,
            'x.svg',
        );
        assert.equal(
            sanitizeDiagramExportPayload({ svg: '<svg/>', fileName: 'diagram' })?.fileName,
            'diagram.svg',
        );
        assert.equal(
            sanitizeDiagramExportPayload({ svg: '<svg/>', fileName: 'Diagram.SVG' })?.fileName,
            'Diagram.SVG',
        );
    });

    it('falls back to a default file name for missing or unusable values', () => {
        assert.equal(sanitizeDiagramExportPayload({ svg: '<svg/>' })?.fileName, 'diagram.svg');
        assert.equal(
            sanitizeDiagramExportPayload({ svg: '<svg/>', fileName: 42 as unknown })?.fileName,
            'diagram.svg',
        );
        assert.equal(
            sanitizeDiagramExportPayload({ svg: '<svg/>', fileName: '///' })?.fileName,
            'diagram.svg',
        );
    });

    it('caps the file name length', () => {
        const long = 'a'.repeat(300);
        const result = sanitizeDiagramExportPayload({ svg: '<svg/>', fileName: long });
        assert.equal(result?.fileName.length <= 100 + '.svg'.length, true);
        assert.equal(result?.fileName.endsWith('.svg'), true);
    });

    it('rejects svg payloads that are not markup strings', () => {
        assert.equal(sanitizeDiagramExportPayload({ svg: 'javascript:alert(1)' }), undefined);
        assert.equal(sanitizeDiagramExportPayload({ svg: '' }), undefined);
        assert.equal(sanitizeDiagramExportPayload({ svg: null as unknown }), undefined);
        assert.equal(sanitizeDiagramExportPayload({ svg: 42 as unknown }), undefined);
        assert.equal(sanitizeDiagramExportPayload({ svg: '<'.repeat(9 * 1024 * 1024) }), undefined);
    });

    it('accepts only plantuml http(s) urls in url mode', () => {
        const url = 'http://www.plantuml.com/plantuml/svg/~1SoWkIImgAStDuNBAJrBGLq2rKl8IVCF2VL9PKep2v9LQ18ykv02j4cbcgW7ElRz2kgbvg7cOfP2QebkGgLn9N2g40';
        assert.deepEqual(
            sanitizeDiagramExportPayload({ url, fileName: 'uml.svg' }),
            { mode: 'url', url, fileName: 'uml.svg' },
        );
        assert.equal(
            sanitizeDiagramExportPayload({ url: 'https://plantuml.com/plantuml/svg/~1abc', fileName: 'x.svg' })?.mode,
            'url',
        );
    });

    it('rejects url payloads pointing outside the plantuml renderer', () => {
        assert.equal(sanitizeDiagramExportPayload({ url: 'https://evil.example.com/x.svg' }), undefined);
        assert.equal(sanitizeDiagramExportPayload({ url: 'http://localhost:8080/svg' }), undefined);
        assert.equal(sanitizeDiagramExportPayload({ url: 'file:///etc/passwd' }), undefined);
        assert.equal(sanitizeDiagramExportPayload({ url: 'vscode://extension/x' }), undefined);
        assert.equal(sanitizeDiagramExportPayload({ url: 'not a url' }), undefined);
        assert.equal(sanitizeDiagramExportPayload({ url: '' }), undefined);
        assert.equal(sanitizeDiagramExportPayload({ url: 'https://' + 'a'.repeat(2100) + '.com' }), undefined);
    });

    it('rejects non-default ports on allowed hosts', () => {
        assert.equal(
            sanitizeDiagramExportPayload({ url: 'https://www.plantuml.com:8443/plantuml/svg/~1abc' }),
            undefined,
        );
        // WHATWG URL 将显式默认端口规范化为空字符串，正常 https 链接不受影响
        assert.equal(
            sanitizeDiagramExportPayload({ url: 'https://www.plantuml.com:443/plantuml/svg/~1abc' })?.mode,
            'url',
        );
    });

    it('rejects ambiguous or empty payloads', () => {
        assert.equal(sanitizeDiagramExportPayload({}), undefined);
        assert.equal(sanitizeDiagramExportPayload(null), undefined);
        assert.equal(sanitizeDiagramExportPayload('svg' as unknown), undefined);
        assert.equal(sanitizeDiagramExportPayload({ svg: '<svg/>', url: 'https://plantuml.com/x' }), undefined);
    });

    it('returns the sanitized svg, not the raw payload', () => {
        const result = sanitizeDiagramExportPayload({
            svg: '<svg onload="alert(1)"><rect/></svg>',
            fileName: 'x.svg',
        });
        assert.deepEqual(result, { mode: 'svg', svg: '<svg><rect/></svg>', fileName: 'x.svg' });
    });

    it('rejects svg payloads whose root element is not svg', () => {
        assert.equal(
            sanitizeDiagramExportPayload({ svg: '<html><body>x</body></html>' }),
            undefined,
        );
    });

});

describe('sanitizeDiagramSvgContent', () => {

    it('keeps clean mermaid-style svg (style + foreignObject) byte-identical', () => {
        const svg = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<svg id="d-1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" width="120" height="80">',
            '<style>#d-1 .node rect{fill:#ECECFF}</style>',
            '<g class="node"><rect width="60" height="40"/></g>',
            '<foreignObject width="60" height="20"><div xmlns="http://www.w3.org/1999/xhtml">label</div></foreignObject>',
            '</svg>',
        ].join('\n');
        assert.equal(sanitizeDiagramSvgContent(svg), svg);
    });

    it('strips paired, self-closing, prefixed and uppercase script elements', () => {
        assert.equal(
            sanitizeDiagramSvgContent('<svg><script>alert(1)</script><rect/></svg>'),
            '<svg><rect/></svg>',
        );
        assert.equal(
            sanitizeDiagramSvgContent('<svg><SCRIPT>alert(1)</SCRIPT><rect/></svg>'),
            '<svg><rect/></svg>',
        );
        assert.equal(
            sanitizeDiagramSvgContent('<svg><script src="https://evil.example/x.js"/><rect/></svg>'),
            '<svg><rect/></svg>',
        );
        assert.equal(
            sanitizeDiagramSvgContent('<svg xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>'),
            '<svg xmlns:x="http://www.w3.org/2000/svg"></svg>',
        );
    });

    it('defeats nested tag-splitting constructions via fixed-point stripping', () => {
        const nested = '<svg><scr<script></script>ipt>alert(1)</scr<script></script>ipt></svg>';
        const sanitized = sanitizeDiagramSvgContent(nested);
        assert.equal(sanitized, '<svg></svg>');
    });

    it('strips event handler attributes and javascript: links', () => {
        assert.equal(
            sanitizeDiagramSvgContent('<svg onload="alert(1)"><a xlink:href="javascript:alert(2)">x</a></svg>'),
            '<svg><a>x</a></svg>',
        );
        assert.equal(
            sanitizeDiagramSvgContent("<svg><a href='javascript:alert(3)'>x</a></svg>"),
            '<svg><a>x</a></svg>',
        );
    });

    it('drops DOCTYPE declarations (external entity surface)', () => {
        const withDoctype = '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg><text>&xxe;</text></svg>';
        const sanitized = sanitizeDiagramSvgContent(withDoctype);
        assert.equal(sanitized, '<svg><text>&xxe;</text></svg>');
    });

    it('rejects markup whose first element is not svg', () => {
        assert.equal(sanitizeDiagramSvgContent('<html><body>x</body></html>'), undefined);
        assert.equal(sanitizeDiagramSvgContent('<!DOCTYPE html><html></html>'), undefined);
        assert.equal(sanitizeDiagramSvgContent('<script>alert(1)</script>'), undefined);
    });

});
