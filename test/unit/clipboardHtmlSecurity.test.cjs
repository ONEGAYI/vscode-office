const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const { JSDOM } = require('jsdom');

const code = buildSync({
    entryPoints: [resolve(__dirname, '../../src/react/view/excel/x-spreadsheet/core/clipboard_html.js')],
    bundle: true, platform: 'browser', format: 'cjs', write: false,
}).outputFiles[0].text;

test('HTML clipboard parsing attaches only inert table content to the live document', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const { window } = dom;
    const { document } = window;
    const appended = [];
    const appendChild = document.body.appendChild.bind(document.body);
    document.body.appendChild = (node) => {
        appended.push(node.cloneNode(true));
        return appendChild(node);
    };
    const module = { exports: {} };
    runInNewContext(code, {
        module, exports: module.exports, window, document, Node: window.Node,
    });

    const result = module.exports.parseHtmlClipboard(
        '<table><tr><td style="color:red" onclick="window.bad=1">safe<img src="bad" onerror="window.bad=1"></td></tr></table>',
    );
    assert.equal(result.rows[0][0].text, 'safe');
    assert.equal(appended.length, 1);
    assert.equal(appended[0].querySelectorAll('img,script,iframe').length, 0);
    assert.equal(appended[0].querySelectorAll('[onclick],[onerror]').length, 0);
});

test('HTML clipboard keeps simple Excel class styles without attaching source style tags', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const { window } = dom;
    const { document } = window;
    const module = { exports: {} };
    runInNewContext(code, {
        module, exports: module.exports, window, document, Node: window.Node,
    });
    const parsed = module.exports.parseHtmlClipboard(
        '<style>td.xl65 { color: rgb(255, 0, 0); background-color: #ffeecc; font-weight: bold; }</style>'
        + '<table><tr><td class="xl65">Styled</td></tr></table>',
    );
    assert.equal(parsed.rows[0][0].text, 'Styled');
    assert.equal(parsed.rows[0][0].style.color, '#ff0000');
    assert.equal(parsed.rows[0][0].style.bgcolor, '#ffeecc');
    assert.equal(parsed.rows[0][0].style.font.bold, true);
    assert.equal(document.querySelectorAll('style').length, 0);
});
