const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

const code = buildSync({
    entryPoints: [resolve(__dirname, '../../src/provider/compress/commonHandler.ts')],
    platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;

test('Office webview opens only allowed external URL schemes', () => {
    const opened = [];
    const events = {};
    const uri = { fsPath: '/tmp/book.xlsx', scheme: 'file', toString: () => 'file:///tmp/book.xlsx' };
    const vscode = {
        Uri: { parse: value => value, file: value => value, joinPath: () => uri },
        env: { openExternal: value => opened.push(value) },
        workspace: { fs: {} },
        commands: { executeCommand() {} },
    };
    const mocks = {
        vscode,
        path: require('node:path'),
        '@/common/fileReadOnly': { isUriReadOnly: async () => false },
        '@/provider/handlers/officeContent': {
            emitFileOfficeOpen() {}, emitVirtualOfficeOpen() {}, isVirtualUri: () => false,
        },
        '@/service/markdown/webviewInputValidation': {
            isOpenExternalLinkAllowed: value => /^(https?:|mailto:)/i.test(value),
        },
    };
    const moduleRef = { exports: {} };
    runInNewContext(code, {
        module: moduleRef, exports: moduleRef.exports, require: name => mocks[name],
        Date, TextEncoder,
    });
    const handler = {
        panel: { title: '', webview: {} },
        on(name, callback) { events[name] = callback; return this; },
    };
    moduleRef.exports.handleCommonEvent(uri, handler, { skipOpen: true });
    for (const value of ['file:///tmp/secret', 'command:workbench.action.files.openFolder', '  https://example.test/page  ']) {
        events.openExternal(value);
    }
    assert.deepEqual(opened, ['https://example.test/page']);
});
