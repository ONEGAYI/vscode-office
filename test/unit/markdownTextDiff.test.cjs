const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

const code = buildSync({
    entryPoints: [resolve(__dirname, '../../src/service/markdown/markdownTextDiff.ts')],
    bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
}).outputFiles[0].text;

function fixture() {
    const calls = [], warnings = [], errors = [];
    class Uri {
        constructor(path) { this.path = path; }
        toString() { return 'file://' + this.path; }
        static isUri(value) { return value instanceof Uri; }
    }
    const api = {
        Uri, FileType: { File: 1, Directory: 2 },
        commands: { executeCommand: async (...args) => { calls.push(args); } },
        window: {
            showWarningMessage: async text => warnings.push(text),
            showErrorMessage: async text => errors.push(text),
        },
        workspace: { fs: { stat: async () => ({ type: 1 }) } },
    };
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: () => api });
    return { ...module.exports, api, calls, warnings, errors, original: new Uri('/a.md'), modified: new Uri('/b.markdown') };
}

test('direct comparison preserves Explorer order and original resources', async () => {
    const f = fixture();
    await f.compareSelectedMarkdown(f.modified, [f.original, f.modified]);
    assert.equal(f.calls.length, 1);
    const [command, original, modified, title, options] = f.calls[0];
    assert.equal(command, 'vscode.diff');
    assert.equal(original, f.original);
    assert.equal(modified, f.modified);
    assert.equal(title, 'a.md ↔ b.markdown');
    assert.equal(options.override, true);
    assert.equal(options.preview, false);
});

test('invalid selections never open a comparison', async () => {
    const f = fixture();
    for (const selection of [undefined, [], [f.original], [f.original, f.original],
        [f.original, new f.api.Uri('/b.txt')], [f.original, {}], [f.original, f.modified, f.original]]) {
        await f.compareSelectedMarkdown(f.original, selection);
    }
    f.api.workspace.fs.stat = async () => ({ type: 2 });
    await f.compareSelectedMarkdown(f.original, [f.original, f.modified]);
    assert.equal(f.calls.length, 0);
    assert.equal(f.warnings.length, 8);
});

test('unavailable files report an error without opening a comparison', async () => {
    const f = fixture();
    f.api.workspace.fs.stat = async () => { throw new Error('missing file'); };
    await f.compareSelectedMarkdown(f.original, [f.original, f.modified]);
    assert.equal(f.calls.length, 0);
    assert.equal(f.errors.length, 1);
});

test('returning to Markdown uses normal associations, not a boolean false override', async () => {
    const f = fixture();
    await f.openMarkdownDiff(f.original, f.modified, 'a ↔ b');
    assert.equal(f.calls[0][4].override, undefined);
});
