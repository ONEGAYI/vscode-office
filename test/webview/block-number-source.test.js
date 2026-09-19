'use strict';

// 宿主消息契约：真实 provider 与表格格式保留逻辑，VSCode API 使用内存文档。
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = 'before\n\n| a | b |\n| --- | --- |\n| x | y |\n\nafter\n';
const INPUT = 'edited\n\n\n| a   | b   |\n| --- | --- |\n| x   | y   |\n\nafter\n';
const PRESERVED = SOURCE.replace('before', 'edited');

function load(relative, dependencies, timer = setTimeout, clear = clearTimeout) {
  const module = { exports: {} };
  const code = transformSync(fs.readFileSync(path.join(ROOT, relative), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  new Function('module', 'exports', 'require', 'setTimeout', 'clearTimeout', code)(module, module.exports, dependencies, timer, clear);
  return module.exports;
}

async function host(initialText = SOURCE, applyResult = true) {
  let text = initialText;
  const listeners = {};
  const sent = [];
  const timers = new Map();
  let timerId = 0;
  let applying;
  const uri = { toString: () => 'file:///source.md', fsPath: '/source.md' };
  const document = { uri, getText: () => text, get lineCount() { return text.split('\n').length; } };
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      applyEdit: edit => new Promise(resolve => {
        applying = () => { if (applyResult) text = edit.text; resolve(applyResult); };
      }),
    },
    commands: { executeCommand() {} },
    WorkspaceEdit: class { replace(_uri, _range, value) { this.text = value; } },
    Range: class {},
  };
  const deps = {
    vscode, path,
    '@/common/extensionResource': { extensionResource: () => uri, readExtensionText: async () => '' },
    '../common/util': { Util: { buildPath: x => x } },
    '../service/markdown/holder': { Holder: {} },
    '../service/markdown/tableFormatPreserver': load('src/service/markdown/tableFormatPreserver.ts', require),
    '../service/markdown/diskChangeCoordinator': {
      registerDiskChangePanel: () => () => {}, getSharedAcknowledgedDiskTexts: () => new Set(),
    },
    '@/common/global': { Global: { getConfig: () => false }, i18n: () => '' },
    '@/service/markdown/blockScroll': { registerMarkdownWebview() {} },
  };
  const { MarkdownEditorProvider } = load('src/provider/markdownEditorProvider.ts', name => deps[name] || {},
    callback => { timers.set(++timerId, callback); return timerId; }, id => timers.delete(id));
  const provider = Object.create(MarkdownEditorProvider.prototype);
  provider.context = {};
  provider.countStatus = {};
  const handler = {
    panel: { webview: { asWebviewUri: x => x }, onDidChangeViewState() {}, onDidDispose() {} },
    on(name, callback) { listeners[name] = callback; return handler; },
    emit(name, payload) { sent.push({ name, payload }); return handler; },
  };
  await provider.handleMarkdown(document, handler, uri);
  return {
    listeners, sent, getText: () => text,
    flushTimer() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); return callbacks.length; },
    async finishApply() { applying(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

it('debounced save acknowledges actual preserved host text only after applyEdit completes', async () => {
  const ctx = await host();
  ctx.listeners.save(INPUT);
  ctx.flushTimer();
  assert.equal(ctx.sent.length, 0);
  await ctx.finishApply();
  assert.equal(ctx.getText(), PRESERVED);
  assert.deepEqual(ctx.sent, [{ name: 'lineNumberSource', payload: { input: INPUT, content: PRESERVED } }]);
});

it('manual and no-op saves also acknowledge source lines', async () => {
  const ctx = await host();
  const saving = ctx.listeners.doSave(INPUT);
  await ctx.finishApply();
  await saving;
  assert.deepEqual(ctx.sent.at(-1), { name: 'lineNumberSource', payload: { input: INPUT, content: PRESERVED } });
  const unchanged = await host(PRESERVED);
  await unchanged.listeners.doSave(INPUT);
  assert.deepEqual(unchanged.sent.at(-1), { name: 'lineNumberSource', payload: { input: INPUT, content: PRESERVED } });
});

it('failed applyEdit never acknowledges the proposed text as applied', async () => {
  const ctx = await host(SOURCE, false);
  const saving = ctx.listeners.doSave(INPUT);
  await ctx.finishApply();
  await saving;
  assert.equal(ctx.getText(), SOURCE);
  assert.deepEqual(ctx.sent.at(-1), { name: 'lineNumberSource', payload: { input: INPUT, content: null } });
});

it('duplicate input suppressed after manual save still refreshes source lines', async () => {
  const ctx = await host(PRESERVED);
  await ctx.listeners.doSave(INPUT);
  ctx.sent.length = 0;
  ctx.listeners.save(INPUT);
  assert.deepEqual(ctx.sent, [{ name: 'lineNumberSource', payload: { input: INPUT, content: PRESERVED } }]);
  ctx.listeners.save(INPUT.replace('edited', 'new edit'));
  assert.equal(ctx.flushTimer(), 1, '冷却期内的新输入仍须排队同步');
  await ctx.finishApply();
  assert.equal(ctx.getText(), PRESERVED.replace('edited', 'new edit'));
  assert.equal(ctx.sent.at(-1).payload.content, ctx.getText());
});
