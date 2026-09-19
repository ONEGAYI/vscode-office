'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '../..');
const browserPath = process.env.BROWSER_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));
const SOURCE = [
  '本阶段提供三个检查分支：', '',
  '| 检查分支 | 现象 | 判定要点 |', '| --- | --- | --- |',
  '| `delta_glitch` | 多次变化 | 至少两次 |',
  '| `high_too_short` | 高电平 | 宽度不足 |',
  '| `low_too_short` | 低电平 | 宽度不足 |', '',
  '#### 缺陷判定依据', '', '',
  '| A | B |', '| --- | --- |', '| x | y |', '', '后续段落',
].join('\n');

test('source line numbers in the complete markdown webview',
  { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async t => {
    const module = { exports: {} };
    new Function('module', 'exports', transformSync(fs.readFileSync(path.join(ROOT,
      'src/service/markdown/tableFormatPreserver.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(module, module.exports);
    const { preserveTableFormat } = module.exports;
    const server = http.createServer((req, res) => {
      const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0]));
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (error, body) => {
        if (error) { res.writeHead(404).end(); return; }
        if (file.endsWith('index.html')) {
          body = body.toString().replace('<base href="{{baseUrl}}/">', '')
            .replace('<script src="index.js" type="module"></script>', '');
        }
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
        res.end(body);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const rootPath = `http://127.0.0.1:${server.address().port}/resource/markdown`;
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
    t.after(() => browser.close());

    for (const mode of ['ir', 'wysiwyg']) {
      await t.test(mode + ': open, typing, Ctrl+S, mode switch and external update', async () => {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(10000);
        try {
          await page.setViewport({ width: 1000, height: 900 });
          await page.evaluateOnNewDocument(() => {
            window.hostMessages = [];
            window.acquireVsCodeApi = () => ({ postMessage: message => window.hostMessages.push(message) });
          });
          await page.goto(rootPath + '/index.html');
          await page.evaluate(() => {
            const VditorClass = window.Vditor;
            window.Vditor = function (...args) { return window.testEditor = new VditorClass(...args); };
          });
          await page.addScriptTag({ type: 'module', url: rootPath + '/index.js' });
          await page.waitForFunction(() => window.hostMessages.some(item => item.type === 'init'));
          const receive = (type, content) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { type, content });
          await receive('open', { content: SOURCE, rootPath, config: { editMode: mode, language: 'en', editorTheme: 'light' } });
          const numbers = () => page.evaluate(() => Array.from(document.querySelectorAll(
            '.vditor-' + testEditor.getCurrentMode() + ' .vditor-reset > [data-lineno]'))
            .map(el => Number(el.getAttribute('data-lineno'))));
          await page.waitForFunction(() => document.querySelectorAll('[data-lineno]').length >= 5);
          assert.deepEqual(await numbers(), [1, 3, 9, 12, 16]);
          if (process.env.LINE_NUMBER_SCREENSHOT_DIR) {
            await page.screenshot({ path: path.join(process.env.LINE_NUMBER_SCREENSHOT_DIR, `line-numbers-${mode}.png`) });
          }
          await page.evaluate(() => {
            window.hostMessages = [];
            const root = testEditor.vditor[testEditor.getCurrentMode()].element;
            const paragraph = root.querySelector('p');
            root.focus();
            const range = document.createRange();
            range.selectNodeContents(paragraph);
            range.collapse(false);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
          });
          await page.keyboard.type('edited');
          await page.waitForFunction(() => window.hostMessages.some(item => item.type === 'save' && item.content.includes('edited')));
          const input = await page.evaluate(() => window.hostMessages.filter(item => item.type === 'save').at(-1).content);
          const applied = preserveTableFormat(SOURCE, input);
          await receive('lineNumberSource', { input, content: applied });
          assert.deepEqual(await numbers(), [1, 3, 9, 12, 16]);

          await page.keyboard.down('Control');
          await page.keyboard.press('s');
          await page.keyboard.up('Control');
          await page.waitForFunction(() => window.hostMessages.some(item => item.type === 'doSave'));
          const manualInput = await page.evaluate(() => window.hostMessages.filter(item => item.type === 'doSave').at(-1).content);
          await receive('lineNumberSource', { input: manualInput, content: preserveTableFormat(applied, manualInput) });
          assert.deepEqual(await numbers(), [1, 3, 9, 12, 16]);

          await page.evaluate(mode => testEditor.switchEditMode(mode === 'ir' ? 'wysiwyg' : 'ir'), mode);
          await page.waitForFunction(() => document.querySelector('.vditor-' + testEditor.getCurrentMode() + ' .vditor-reset > [data-lineno]'));
          assert.deepEqual(await numbers(), [1, 3, 9, 12, 16]);
          await receive('update', '\n\n' + SOURCE);
          assert.deepEqual(await numbers(), [3, 5, 11, 14, 18]);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  });
