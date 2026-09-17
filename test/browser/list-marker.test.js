'use strict';

// Real mouse input is required here: jsdom does not implement hit testing or
// Chromium's caret normalization at CSS list markers.
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

test('first marker click preserves character position in both editor modes',
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
        page.on('pageerror', error => console.error(error.message));
        try {
          await page.setViewport({ width: 1000, height: 700 });
          await page.goto(base + '/');
          await page.setContent('<html><head></head><body><div id="app"></div></body></html>');
          await page.addStyleTag({ url: base + '/vditor/dist/index.css' });
          await page.addStyleTag({ url: base + '/resource/markdown/index.css' });
          await page.addScriptTag({ url: base + '/vditor/dist/js/lute/lute.min.js', id: 'vditorLuteScript' });
          await page.addScriptTag({ url: base + '/vditor/dist/js/i18n/en_US.js' });
          await page.addScriptTag({ url: base + '/vditor/dist/index.min.js' });
          await page.addScriptTag({ url: base + '/resource/markdown/list-marker.js' });
          await page.evaluate(({ mode, base }) => new Promise(resolve => {
            window.vditor = new Vditor('app', {
              value: '123. first\n124. second\n125. third\n', mode,
              i18n: VditorI18n, cdn: base + '/vditor', height: 600,
              cache: { enable: false }, toolbar: [],
              after() { ListMarkerLive.install(window.vditor); resolve(); },
            });
          }), { mode, base });
          const selector = `.vditor-${mode} .vditor-reset`;
          const getPoint = async (index, offset) => page.evaluate(({ selector, index, offset }) => {
            const li = document.querySelector(selector).querySelectorAll('li')[index];
            const span = li.querySelector('.vmd-li-marker');
            if (!span) throw new Error('marker must be live for calibration');
            const r = document.createRange();
            r.setStart(span.firstChild, offset); r.setEnd(span.firstChild, offset + 1);
            const rect = r.getBoundingClientRect();
            return { x: rect.left + rect.width * 0.2, y: rect.top + rect.height / 2 };
          }, { selector, index, offset });
          // Measure real glyph bounds without synthesizing mouse or selection events.
          await page.click(selector + ' li:nth-child(2)');
          await page.waitForSelector(selector + ' li:nth-child(2) .vmd-li-marker');
          const readCaret = () => page.evaluate(() => {
            const s = getSelection();
            return { text: s.anchorNode.textContent, offset: s.anchorOffset, inMarker: !!s.anchorNode.parentElement.closest('.vmd-li-marker') };
          });
          // Check every character with both native hit-testing APIs. The
          // fallback is the API available in VS Code 1.86 / Chromium 118.
          for (const fallback of [false, true]) {
            if (fallback) await page.evaluate(() => { document.caretPositionFromPoint = undefined; });
            for (const offset of [0, 1, 2, 3]) {
              const point = await getPoint(1, offset);
              await page.click(selector + ' li:nth-child(1)');
              await page.waitForFunction(s => !document.querySelector(s + ' li:nth-child(2) .vmd-li-marker'), {}, selector);
              await page.mouse.click(point.x, point.y);
              await page.waitForSelector(selector + ' li:nth-child(2) .vmd-li-marker');
              assert.deepEqual(await readCaret(), { text: '124.\u00a0', offset, inMarker: true });
              await page.mouse.click(point.x, point.y);
              assert.deepEqual(await readCaret(), { text: '124.\u00a0', offset, inMarker: true });
            }
          }
          const from = await getPoint(1, 0);
          const to = await getPoint(1, 2);
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          await page.mouse.move(to.x, to.y, { steps: 8 });
          await page.mouse.up();
          assert.equal(await page.evaluate(() => getSelection().toString()), '12');

          await page.click(selector + ' li:nth-child(2)');
          await page.keyboard.press('End');
          await page.keyboard.down('Shift');
          await page.keyboard.press('Home');
          await page.keyboard.up('Shift');
          assert.equal(await page.evaluate(() => getSelection().toString()), '124.\u00a0second');
          await page.keyboard.press('Home');
          assert.deepEqual(await page.evaluate(() => {
            const s = getSelection();
            const li = (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement).closest('li');
            const prefix = document.createRange();
            prefix.selectNodeContents(li);
            prefix.setEnd(s.anchorNode, s.anchorOffset);
            return { collapsed: s.isCollapsed, prefix: prefix.toString().replace(/\u200b/g, '') };
          }), { collapsed: true, prefix: '' }, 'Home reaches the beginning of the item');
          assert.equal(await page.evaluate(() => vditor.getValue()), '123. first\n124. second\n125. third\n');
        } finally { await page.close(); }
      });
    }
  });
