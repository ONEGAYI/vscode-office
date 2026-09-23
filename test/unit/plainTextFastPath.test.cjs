const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

const code = buildSync({
    entryPoints: [resolve(__dirname, '../../vditor/src/ts/util/plainTextFastPath.ts')],
    platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;

function allowed(text, offset, data) {
    const moduleRef = { exports: {} };
    runInNewContext(code, {
        module: moduleRef, exports: moduleRef.exports,
        getSelection: () => ({ getRangeAt: () => ({
            collapsed: true,
            startContainer: { nodeType: 3, textContent: text },
            startOffset: offset,
        }) }),
    });
    return moduleRef.exports.canUsePlainTextFastPath(
        { documentInitialLength: 20000 },
        { inputType: 'insertText', data, isComposing: false },
    );
}

test('a hyphen or plus inside a word uses the large-document plain-text path', () => {
    assert.equal(allowed('te-xt', 3, '-'), true);
    assert.equal(allowed('te+xt', 3, '+'), true);
});

test('Markdown list markers and inline delimiters still use structural rendering', () => {
    assert.equal(allowed('- item', 1, '-'), false);
    assert.equal(allowed('te*xt', 3, '*'), false);
});
