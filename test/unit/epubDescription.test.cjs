const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const code = buildSync({
    entryPoints: [resolve(__dirname, '../../src/react/view/epub/EpubDescription.tsx')],
    bundle: true, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'], write: false,
}).outputFiles[0].text;
const moduleRef = { exports: {} };
new Function('require', 'module', 'exports', code)(require, moduleRef, moduleRef.exports);

test('EPUB description renders metadata as text', () => {
    const html = renderToStaticMarkup(React.createElement(moduleRef.exports.default, {
        description: '<img src=x onerror="window.bad=1"> & notes',
    }));
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&amp; notes/);
});
