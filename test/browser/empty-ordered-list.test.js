'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '../..');
const browserPath = process.env.BROWSER_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));

test('空段落触发有序列表后可见 1. 且光标留在列表项中',
  { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async t => {
    const { default: puppeteer } = await import('puppeteer-core');
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<div id="app"></div>');
        return;
      }
      const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0]));
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, body) => {
        if (err) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream');
        res.end(body);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
    t.after(() => browser.close());
    const base = `http://127.0.0.1:${server.address().port}`;

    for (const mode of ['wysiwyg', 'ir']) {
      for (const action of ['hotkey', 'toolbar']) {
        await t.test(`${mode} ${action}`, async () => {
          const page = await browser.newPage();
          try {
            await page.goto(base + '/');
            await page.addStyleTag({ url: base + '/vditor/dist/index.css' });
            await page.addStyleTag({ url: base + '/resource/markdown/index.css' });
            await page.addScriptTag({ url: base + '/vditor/dist/js/lute/lute.min.js', id: 'vditorLuteScript' });
            await page.addScriptTag({ url: base + '/vditor/dist/js/i18n/en_US.js' });
            await page.addScriptTag({ url: base + '/vditor/dist/index.min.js' });
            await page.addScriptTag({ url: base + '/resource/markdown/list-marker.js' });
            await page.evaluate(({ mode, base }) => new Promise(resolve => {
              window.vditor = new Vditor('app', {
                value: '1\n\n2\n', mode,
                i18n: VditorI18n, cdn: base + '/vditor', height: 600,
                cache: { enable: false }, toolbar: ['ordered-list'],
                after() { ListMarkerLive.install(window.vditor); resolve(); },
              });
            }), { mode, base });
            const editor = `.vditor-${mode} .vditor-reset`;
            await page.click(editor + ' > p:first-of-type');
            await page.keyboard.press('End');
            await page.keyboard.press('Enter');
            const before = await page.evaluate(selector => {
              const root = document.querySelector(selector);
              const s = getSelection();
              return {
                html: root.innerHTML,
                block: (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement)
                  .closest('[data-block]')?.outerHTML,
              };
            }, editor);
            assert.match(before.block || '', /^<p\b/, '前置：Enter 后光标位于空段落：' + JSON.stringify(before));

            if (action === 'hotkey') {
              await page.keyboard.down('Control');
              await page.keyboard.press('o');
              await page.keyboard.up('Control');
            }
            else await page.click('.vditor-toolbar [data-type="ordered-list"]');

            const after = await page.evaluate(selector => {
              const root = document.querySelector(selector);
              const ol = root.querySelector('ol');
              const li = ol?.querySelector(':scope > li');
              const s = getSelection();
              return {
                html: root.innerHTML,
                value: vditor.getValue(),
                marker: li && getComputedStyle(li, '::before').content,
                caretInLi: !!li?.contains(s.anchorNode),
                previousText: ol?.previousElementSibling?.textContent,
                nextText: ol?.nextElementSibling?.textContent,
              };
            }, editor);
            assert.equal(after.previousText, '1', '空列表应位于 1 后：' + JSON.stringify(after));
            assert.equal(after.nextText, '2', '空列表应位于 2 前：' + JSON.stringify(after));
            assert.equal(after.marker, '"1. "', '应显示 1.：' + JSON.stringify(after));
            assert.equal(after.caretInLi, true, '光标应留在列表项中：' + JSON.stringify(after));
            assert.match(after.value, /^1\.[ \t]*$/m, '保存的 Markdown 应含空列表项：' + JSON.stringify(after));

            await page.evaluate(() => vditor.setValue(vditor.getValue()));
            const reloaded = await page.evaluate(selector => ({
              value: vditor.getValue(),
              item: document.querySelector(selector + ' > ol > li')?.outerHTML,
            }), editor);
            assert.ok(reloaded.item, '重载后空列表项应保留：' + JSON.stringify(reloaded));
            assert.match(reloaded.value, /^1\.[ \t]*$/m, JSON.stringify(reloaded));

            await page.click(editor + ' > ol > li');
            await page.keyboard.type('x');
            const typed = await page.evaluate(() => vditor.getValue());
            assert.match(typed, /^1\. x$/m, '在空列表项继续输入应进入正文：' + JSON.stringify(typed));
          } finally { await page.close(); }
        });
      }
    }
  });
