const assert = require('node:assert/strict');
const { test } = require('node:test');
const { transformSync } = require('esbuild');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

function load(file, requireModule) {
    const code = transformSync(readFileSync(resolve(__dirname, '../../src/service', file), 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'node20',
    }).code;
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: requireModule, URL });
    return module.exports;
}

test('single-file switching still works before the Tab API was introduced', async () => {
    const calls = [];
    const uri = { toString: () => 'file:///a.md' };
    const api = {
        window: { activeTextEditor: { document: { uri } } },
        commands: { executeCommand: async (...args) => calls.push(args) },
        Uri: { parse: text => text },
    };
    const planner = load('markdown/switchEditorPlanner.ts', () => ({}));
    const { MarkdownService } = load('markdownService.ts', name => name === 'vscode' ? api
        : name.endsWith('switchEditorPlanner') ? planner
        : ['os', 'path', 'fs', 'child_process'].includes(name) ? require(name) : {});
    const service = new MarkdownService({});
    await service.switchEditor();
    assert.equal(calls[0][2], 'cweijan.markdownViewer');
    api.window.activeTextEditor = undefined;
    await service.switchEditor(uri);
    assert.equal(calls[1][2], 'default');
});
