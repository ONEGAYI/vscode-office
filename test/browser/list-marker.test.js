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

test('marker clicks preserve character position and boundary input reaches saved content',
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
              input(value) { window.savedMarkdown = value; },
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
          // Both halves of the separator, including a first click from another
          // item, must insert real content and reach the host's save callback.
          const cdp = await page.createCDPSession();
          for (const marker of ['-', '1.']) {
            for (const fraction of [0.2, 0.8]) {
              for (const input of ['keyboard', 'insertText', 'ime', 'backspace']) {
                const source = `1. parent\n   ${marker} 三 agent\n`;
                const text = input === 'keyboard' ? 'wrong' : '中文';
                const expected = input === 'backspace' ? '1. parent\n\n   三 agent\n'
                  : `1. parent\n   ${marker} ${text}三 agent\n`;
                await page.evaluate(value => { vditor.setValue(value); window.savedMarkdown = null; }, source);
                const item = selector + ' li li';
                await page.click(item);
                await page.waitForSelector(item + ' .vmd-li-marker');
                const gap = await page.evaluate(({ item, fraction }) => {
                  const span = document.querySelector(item + ' .vmd-li-marker');
                  const range = document.createRange();
                  range.setStart(span.firstChild, span.textContent.length - 1);
                  range.setEnd(span.firstChild, span.textContent.length);
                  const rect = range.getBoundingClientRect();
                  return { x: rect.left + rect.width * fraction, y: rect.top + rect.height / 2 };
                }, { item, fraction });
                // Fold the calibrated marker so the tested click activates it.
                const parentPoint = await page.$eval(selector + ' li', el => {
                  const rect = el.getBoundingClientRect();
                  return { x: rect.left + 20, y: rect.top + 5 };
                });
                await page.mouse.click(parentPoint.x, parentPoint.y);
                await page.waitForFunction(s => !document.querySelector(s + ' .vmd-li-marker'), {}, item);
                await page.mouse.click(gap.x, gap.y);
                if (input === 'keyboard') await page.keyboard.type(text);
                else if (input === 'backspace') await page.keyboard.press('Backspace');
                else if (input === 'insertText') await cdp.send('Input.insertText', { text });
                else {
                  await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
                  await cdp.send('Input.insertText', { text });
                }
                assert.equal(await page.evaluate(() => vditor.getValue()), expected,
                  `${mode}/${marker}/${fraction}/${input}: boundary input must survive serialization`);
                await page.waitForFunction(value => window.savedMarkdown === value, { timeout: 3000 }, expected);
                if (input === 'backspace') {
                  assert.equal(await page.$$eval(selector + ' li li, ' + selector + ' p .vmd-li-marker', els => els.length), 0);
                  await page.keyboard.down('Control');
                  await page.keyboard.press('z');
                  await page.keyboard.up('Control');
                  await page.waitForFunction(value => vditor.getValue() === value, { timeout: 3000 }, source);
                  continue;
                }
                await page.evaluate(() => vditor.setValue(vditor.getValue()));
                assert.equal(await page.$eval(item, el => el.textContent), `${text}三 agent`,
                  'saved text remains visible after re-rendering');
              }
            }
          }
        } finally { await page.close(); }
      });
    }
  });
