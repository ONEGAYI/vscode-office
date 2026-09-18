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

test('cross-item selection includes markers and replaces complete lists cleanly',
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
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream');
        res.end(body);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [mode, kind] of ['ir', 'wysiwyg'].flatMap(mode => [[mode, 'ordered'], [mode, 'unordered']])) {
      const original = kind === 'ordered' ? 'before\n\n1. alpha\n2. beta\n3. gamma\n\nafter\n'
        : 'before\n\n- alpha\n- beta\n- gamma\n\nafter\n';
      for (const action of ['selection', 'Backspace', 'Delete', 'type', 'paste', 'partial', 'subset', 'empty-paste', 'marker-partial', 'mouse']) {
        await t.test(`${mode} ${kind}: ${action}`, async () => {
          const page = await browser.newPage();
          try {
            await page.goto(base);
            await page.addStyleTag({ url: base + '/resource/markdown/dist/index.css' });
            await page.addStyleTag({ url: base + '/resource/markdown/index.css' });
            for (const file of ['dist/js/lute/lute.min.js', 'dist/js/i18n/en_US.js', 'dist/index.min.js', 'list-marker.js']) {
              await page.addScriptTag({ url: base + '/resource/markdown/' + file,
                ...(file.includes('lute.min') ? { id: 'vditorLuteScript' } : {}) });
            }
            await page.evaluate(({ mode, base, original }) => new Promise(resolve => {
              window.vditor = new Vditor('app', {
                value: original, mode,
                i18n: VditorI18n, cdn: base + '/resource/markdown', height: 600,
                cache: { enable: false }, toolbar: ['undo', 'redo'],
                after() { ListMarkerLive.install(window.vditor); resolve(); },
              });
            }), { mode, base, original });
            const selector = `.vditor-${mode} .vditor-reset`;
            await page.click(selector + (action === 'marker-partial' ? ' li:first-child' : ' li:last-child'));
            await page.waitForSelector(selector + ' .vmd-li-marker');
            // Backwards selection from the focused last row, as in the report.
            await page.evaluate(({ selector, action }) => {
              if (action === 'mouse') return;
              const lis = document.querySelector(selector).querySelectorAll('li');
              if (action === 'marker-partial') {
                getSelection().setBaseAndExtent(lis[0].querySelector('.vmd-li-marker').firstChild, 0,
                  lis[2].lastChild, 4);
                return;
              }
              getSelection().setBaseAndExtent(lis[action === 'subset' ? 1 : 2].lastChild,
                action === 'partial' || action === 'subset' ? 4 : 5,
                lis[0].lastChild, action === 'partial' ? 1 : 0);
            }, { selector, action });
            if (action === 'mouse') {
              const points = await page.evaluate(selector => {
                const lis = document.querySelector(selector).querySelectorAll('li');
                const range = document.createRange();
                range.selectNodeContents(lis[2].lastChild);
                const end = range.getBoundingClientRect();
                const first = lis[0].getBoundingClientRect();
                return { from: { x: end.right, y: end.top + end.height / 2 },
                  to: { x: first.left - 10, y: first.top + first.height / 2 } };
              }, selector);
              await page.mouse.move(points.from.x, points.from.y);
              await page.mouse.down();
              await page.mouse.move(points.to.x, points.to.y, { steps: 12 });
              await page.mouse.up();
            }
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 80)));
            if (action === 'selection') {
              const markers = await page.$$eval(selector + ' li', lis => lis.map(li => ({
                live: !!li.querySelector('.vmd-li-marker'),
                background: getComputedStyle(li, '::before').backgroundColor,
              })));
              for (const marker of markers) {
                assert.ok(marker.live || !['transparent', 'rgba(0, 0, 0, 0)'].includes(marker.background),
                  'selected item marker must be highlighted: ' + JSON.stringify(markers));
              }
              return;
            }
            if (action === 'type') await page.keyboard.type('replacement');
            else if (action === 'paste' || action === 'empty-paste') await page.evaluate(({ selector, action }) => {
              const clipboardData = new DataTransfer();
              if (action === 'paste') clipboardData.setData('text/plain', 'replacement');
              document.querySelector(selector).dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData,
              }));
            }, { selector, action });
            else await page.keyboard.press(['partial', 'subset', 'marker-partial', 'mouse'].includes(action) ? 'Backspace' : action);
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
            const result = await page.evaluate(selector => ({
              markdown: vditor.getValue(),
              lists: document.querySelector(selector).querySelectorAll('ol, ul').length,
              items: document.querySelector(selector).querySelectorAll('li').length,
            }), selector);
            if (action === 'empty-paste') {
              assert.equal(result.markdown, original);
              return;
            }
            if (action === 'subset') {
              assert.equal(result.items, 1, 'fully selected items leave no empty item: ' + JSON.stringify(result));
              assert.match(result.markdown, /(?:\d\.|-) gamma\n/);
              return;
            }
            if (action === 'partial') {
              assert.equal(result.lists, 1, JSON.stringify(result));
              assert.equal(result.markdown.trim(), `before\n\n${kind === 'ordered' ? '1.' : '-'} aa\n\nafter`);
              return;
            }
            if (action === 'marker-partial') {
              assert.equal(result.markdown.trim(), `before\n\n${kind === 'ordered' ? '1.' : '-'} a\n\nafter`);
              return;
            }
            assert.equal(result.lists, 0, JSON.stringify(result));
            assert.equal(result.markdown.trim(), action === 'type' || action === 'paste'
              ? 'before\n\nreplacement\n\nafter' : 'before\n\n\nafter');
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
            await page.click('[data-type="undo"]');
            assert.equal(await page.evaluate(() => vditor.getValue()),
              original, 'undo restores the complete list');
          } finally { await page.close(); }
        });
      }
    }
  });
