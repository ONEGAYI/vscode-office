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
const source = '1. **Agent 注册**：~~内联法或目录法二选一~~，注入后可按触发词路由到对应 agent：\n'
  + '   - 内联法：三 agent 定义以配置内联（opencode.json agent 键，prompt 正文经 `{file:./}` 引用安装包内资产文件）随安装包分发，经渲染注入。\n'
  + '   - 目录法：三 agent 定义文件（`agent/*.md`）随安装包内置为一个配置目录，宿主启动 serve 时经 `OPENCODE_CONFIG_DIR` 注入。\n';

test('loose list markers stay on the first text line after Backspace and typed list creation',
  { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async t => {
    const { default: puppeteer } = await import('puppeteer-core');
    const server = http.createServer((req, res) => {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<div id="app"></div>'); return; }
      const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0]));
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, body) => {
        if (err) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream');
        res.end(body);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
    t.after(() => browser.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const mode of ['ir', 'wysiwyg']) {
      await t.test(mode, async () => {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width: 900, height: 800 });
          await page.goto(base);
          await page.addStyleTag({ url: base + '/resource/markdown/dist/index.css' });
          await page.addStyleTag({ url: base + '/resource/markdown/index.css' });
          for (const file of ['dist/js/lute/lute.min.js', 'dist/js/i18n/en_US.js', 'dist/index.min.js', 'list-marker.js']) {
            await page.addScriptTag({ url: base + '/resource/markdown/' + file,
              ...(file.includes('lute.min') ? { id: 'vditorLuteScript' } : {}) });
          }
          await page.evaluate(({ mode, base, source }) => new Promise(resolve => {
            window.vditor = new Vditor('app', {
              value: source, mode, i18n: VditorI18n, cdn: base + '/resource/markdown', height: 750,
              cache: { enable: false }, toolbar: [],
              after() { ListMarkerLive.install(window.vditor); resolve(); },
            });
          }), { mode, base, source });
          const root = `.vditor-${mode} .vditor-reset`;
          const capture = async stage => {
            if (process.env.LIST_LAYOUT_SCREENSHOT_DIR) {
              const list = await page.$(root + ' > ol');
              await list.screenshot({ path: path.join(process.env.LIST_LAYOUT_SCREENSHOT_DIR, `${mode}-${stage}.png`) });
            }
          };
          const placeAtText = async text => page.evaluate(({ root, text }) => {
            const editor = document.querySelector(root);
            editor.focus();
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              if (!node.textContent.startsWith(text)) continue;
              const range = document.createRange();
              range.setStart(node, 0); range.collapse(true);
              getSelection().removeAllRanges(); getSelection().addRange(range);
              return;
            }
            throw new Error('Text not found: ' + text);
          }, { root, text });
          const assertAligned = async label => {
            const rows = await page.$$eval(root + ' li', items => items.map(li => {
              const p = li.querySelector(':scope > p');
              const live = li.querySelector(':scope > .vmd-li-marker');
              return { text: p?.textContent, tight: li.parentElement.getAttribute('data-tight'), gap: p ? p.getBoundingClientRect().top - li.getBoundingClientRect().top : 0,
                liveBox: live && { width: live.getBoundingClientRect().width, height: live.getBoundingClientRect().height,
                  gap: p ? live.getBoundingClientRect().top - p.getBoundingClientRect().top : 0 },
                marker: live?.textContent || getComputedStyle(li, '::before').content, html: li.outerHTML };
            }));
            for (const row of rows) {
              assert.ok(Math.abs(row.gap) < 2, `${label}: marker must share first paragraph's line: ${JSON.stringify(row)}`);
              assert.ok(!['none', 'normal', '""'].includes(row.marker), `${label}: marker remains visible: ${JSON.stringify(row)}`);
              if (row.liveBox) assert.ok(row.liveBox.width > 0 && row.liveBox.height > 0 && Math.abs(row.liveBox.gap) < 2,
                `${label}: live marker shares the first line: ${JSON.stringify(row)}`);
            }
          };
          await placeAtText('内联法：');
          await page.keyboard.press('Backspace');
          await assertAligned('after Backspace, unfocused parent');
          await capture('backspace');
          assert.equal(await page.$$eval(root + ' li li', items => items.length), 1);
          await placeAtText('Agent 注册');
          await page.waitForSelector(root + ' ol > li > .vmd-li-marker');
          await assertAligned('focused parent');
          await placeAtText('内联法：');
          await page.keyboard.type('- ');
          await page.waitForFunction(s => document.querySelectorAll(s + ' li li').length === 2, {}, root);
          await assertAligned('after typing a list marker');
          await capture('typed-list');
          const value = await page.evaluate(() => vditor.getValue());
          assert.match(value, /- 内联法：/);
          assert.match(value, /- 目录法：/);
          await page.evaluate(() => vditor.setValue(vditor.getValue()));
          await assertAligned('after reopening');
          assert.equal(await page.evaluate(() => vditor.getValue()), value);
        } finally { await page.close(); }
      });
    }
  });
