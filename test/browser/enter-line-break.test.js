'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const ROOT = process.env.VDITOR_ASSET_ROOT || path.resolve(__dirname, '../..');
const browserPath = process.env.BROWSER_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

test('Enter line-break preference in both editing modes',
  { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async t => {
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
    t.after(() => browser.close());
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<div id="app"></div>'); return;
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
    const base = `http://127.0.0.1:${server.address().port}`;
    const init = async (page, mode, preserve = false) => {
      await page.goto(base);
      if (!preserve) await page.evaluate(() => localStorage.clear());
      await page.addStyleTag({ url: base + '/resource/markdown/dist/index.css' });
      for (const file of ['js/lute/lute.min.js', 'js/i18n/zh_CN.js', 'index.min.js']) {
        await page.addScriptTag({ url: base + '/resource/markdown/dist/' + file,
          ...(file.includes('lute.min') ? { id: 'vditorLuteScript' } : {}) });
      }
      await page.evaluate(({ mode, base }) => new Promise(resolve => {
        window.vditor = new Vditor('app', {
          value: 'alphabeta', mode, i18n: VditorI18n,
          cdn: base + '/resource/markdown', height: 600,
          cache: { enable: false }, toolbar: ['settings', 'undo', 'redo'],
          input(value) { window.savedMarkdown = value; }, after: resolve,
        });
      }), { mode, base });
    };
    const settle = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
    const press = async (page, chord) => {
      const keys = chord.split('+');
      for (const key of keys.slice(0, -1)) await page.keyboard.down(key);
      await page.keyboard.press(keys.at(-1));
      for (const key of keys.slice(0, -1).reverse()) await page.keyboard.up(key);
    };
    const caret = (page, mode, start = 5, end = start) => page.evaluate(({ mode, start, end }) => {
      const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
      const p = root.querySelector('p');
      root.focus();
      const range = document.createRange();
      range.setStart(p.firstChild, start); range.setEnd(p.firstChild, end);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    }, { mode, start, end });
    for (const mode of ['ir', 'wysiwyg']) {
      await t.test(`${mode}: Enter inserts a line break when enabled`, async () => {
        const page = await browser.newPage();
        try {
          await init(page, mode);
          await page.evaluate(() => localStorage.setItem('vditor-global-settings', JSON.stringify({ enterLineBreak: true })));
          await caret(page, mode);
          await page.keyboard.press('Enter');
          await settle(page);
          assert.equal(await page.evaluate(() => vditor.getValue()), 'alpha\nbeta\n');
          await page.waitForFunction(() => window.savedMarkdown === 'alpha\nbeta\n', { timeout: 3000 });
          await page.click('[data-type="undo"]');
          await settle(page);
          assert.equal(await page.evaluate(() => vditor.getValue()), 'alphabeta\n');
          await page.click('[data-type="redo"]');
          await settle(page);
          assert.equal(await page.evaluate(() => vditor.getValue()), 'alpha\nbeta\n');
        } finally { await page.close(); }
      });
      for (const [enabled, key, expected] of [
        [false, 'Enter', 'alpha\n\nbeta\n'],
        [false, 'Shift+Enter', 'alpha\nbeta\n'],
        [true, 'Shift+Enter', 'alpha\n\nbeta\n'],
      ]) {
        await t.test(`${mode}: ${key}, preference ${enabled}`, async () => {
          const page = await browser.newPage();
          try {
            await init(page, mode);
            await page.evaluate(enabled => localStorage.setItem('vditor-global-settings', JSON.stringify({ enterLineBreak: enabled })), enabled);
            await caret(page, mode);
            await press(page, key);
            await settle(page);
            assert.equal(await page.evaluate(() => vditor.getValue()), expected);
          } finally { await page.close(); }
        });
      }
      for (const [start, end, expected] of [
        [9, 9, 'alphabeta\nX\n'],
        [2, 7, 'al\nXta\n'],
      ]) {
        await t.test(`${mode}: line break and typing at ${start}..${end}`, async () => {
          const page = await browser.newPage();
          try {
            await init(page, mode);
            await page.evaluate(() => localStorage.setItem('vditor-global-settings', JSON.stringify({ enterLineBreak: true })));
            await caret(page, mode, start, end);
            await page.keyboard.press('Enter');
            await page.keyboard.type('X');
            await settle(page);
            assert.equal(await page.evaluate(() => vditor.getValue()), expected);
          } finally { await page.close(); }
        });
      }
      await t.test(`${mode}: settings toggle persists, exports, and turns off`, async () => {
        const page = await browser.newPage();
        try {
          await init(page, mode);
          await page.evaluate(() => localStorage.clear());
          await page.click('[data-type="settings"]');
          const toggle = '[data-toggle-key="enterLineBreak"]';
          assert.equal(await page.$eval(toggle, el => el.getAttribute('aria-checked')), 'false');
          await page.click(toggle);
          assert.equal(await page.$eval(toggle, el => el.getAttribute('aria-checked')), 'true');
          assert.equal(await page.evaluate(() => vditor.exportViewerSettings().globalSettings.enterLineBreak), true);
          await init(page, mode, true);
          await page.click('[data-type="settings"]');
          assert.equal(await page.$eval(toggle, el => el.getAttribute('aria-checked')), 'true');
          await page.click(toggle);
          await caret(page, mode);
          await page.keyboard.press('Enter');
          await settle(page);
          assert.equal(await page.evaluate(() => vditor.getValue()), 'alpha\n\nbeta\n');
        } finally { await page.close(); }
      });
      for (const [value, selector] of [
        ['# alphabeta', 'h1'], ['- alphabeta', 'li'],
        ['> alphabeta', 'blockquote p'], ['| alphabeta |\n| --- |\n| cell |', 'th'],
      ]) {
        await t.test(`${mode}: ${selector} keeps its original Enter behavior`, async () => {
          const results = [];
          for (const enabled of [false, true]) {
            const page = await browser.newPage();
            try {
              await init(page, mode);
              await page.evaluate(({ enabled, value, mode, selector }) => {
                localStorage.setItem('vditor-global-settings', JSON.stringify({ enterLineBreak: enabled }));
                vditor.setValue(value);
                const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
                const target = root.querySelector(selector);
                const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
                let node;
                while ((node = walker.nextNode()) && !node.textContent.includes('alphabeta')) {}
                root.focus();
                const range = document.createRange(); range.setStart(node, node.textContent.indexOf('alpha') + 5); range.collapse(true);
                getSelection().removeAllRanges(); getSelection().addRange(range);
              }, { enabled, value, mode, selector });
              await page.keyboard.press('Enter');
              await settle(page);
              results.push(await page.evaluate(() => vditor.getValue()));
            } finally { await page.close(); }
          }
          assert.equal(results[1], results[0]);
        });
      }
    }
  });
