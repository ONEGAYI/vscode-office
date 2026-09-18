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

test('toolbar-created lists display markers and retain multi-paragraph selections',
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
    for (const mode of ['ir', 'wysiwyg']) {
      for (const [type, count] of ['list', 'ordered-list', 'check'].flatMap(type => [[type, 1], [type, 3]])) {
        await t.test(`${mode}: ${type}, ${count} paragraphs`, async () => {
          const page = await browser.newPage();
          try {
            await page.goto(base);
            await page.addStyleTag({ url: base + '/resource/markdown/dist/index.css' });
            await page.addStyleTag({ url: base + '/resource/markdown/index.css' });
            for (const file of ['dist/js/lute/lute.min.js', 'dist/js/i18n/en_US.js', 'dist/index.min.js', 'list-marker.js']) {
              await page.addScriptTag({ url: base + '/resource/markdown/' + file,
                ...(file.includes('lute.min') ? { id: 'vditorLuteScript' } : {}) });
            }
            await page.evaluate(({ mode, base }) => new Promise(resolve => {
              window.vditor = new Vditor('app', {
                value: 'before\n\n送上\n\n的是\n\n分从\n\nafter\n', mode,
                i18n: VditorI18n, cdn: base + '/resource/markdown', height: 600,
                cache: { enable: false }, toolbar: ['list', 'ordered-list', 'check'],
                after() { ListMarkerLive.install(window.vditor); resolve(); },
              });
            }), { mode, base });
            await page.evaluate(({ mode, count }) => {
              const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
              const ps = root.querySelectorAll('p');
              root.focus();
              const range = document.createRange();
              range.setStart(ps[1].firstChild, 0);
              range.setEnd(ps[count].firstChild, 2);
              getSelection().removeAllRanges(); getSelection().addRange(range);
            }, { mode, count });
            await page.click(`[data-type="${type}"]`);
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)));
            const result = await page.evaluate(mode => {
              const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
              return {
                selected: getSelection().toString().replace(/[\r\n]/g, ''),
                markers: Array.from(root.querySelectorAll('li')).map(li => ({
                  marker: li.getAttribute('data-marker'),
                  before: getComputedStyle(li, '::before').content,
                  native: getComputedStyle(li).listStyleType,
                  live: li.querySelector('.vmd-li-marker')?.textContent,
                })),
                markdown: vditor.getValue(),
              };
            }, mode);
            const expectedText = count === 1 ? '送上' : '送上的是分从';
            assert.equal(result.markers.length, count, JSON.stringify(result));
            if (type !== 'check') {
              for (const [index, marker] of result.markers.entries()) {
                assert.equal(marker.marker, type === 'list' ? '-' : `${index + 1}.`);
                if (type === 'list' && !marker.live) assert.equal(marker.before, '"• "', JSON.stringify(result));
                assert.ok(marker.live?.trim() ||
                  (!['none', 'normal', '" "', '""'].includes(marker.before) && marker.marker) ||
                  marker.native !== 'none', 'list marker must be visible: ' + JSON.stringify(result));
              }
            }
            assert.equal(result.selected, expectedText, JSON.stringify(result));
            // Keep the selection and convert the same list to another type.
            // This follows the single-list branch, unlike the paragraph batch.
            const nextType = type === 'check' ? 'list' : 'check';
            await page.click(`[data-type="${nextType}"]`);
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)));
            assert.equal(await page.evaluate(() => getSelection().toString().replace(/[\r\n]/g, '')),
              expectedText, `${mode}: ${type} -> ${nextType} retains selection`);
            if (nextType === 'list') {
              const selector = `.vditor-${mode} .vditor-reset`;
              assert.match(await page.evaluate(() => vditor.getValue()), /^- +送上$/m);
              await page.click(selector + ' li');
              await page.waitForSelector(selector + ' .vmd-li-marker');
              assert.equal(await page.$eval(selector + ' .vmd-li-marker', el => el.textContent), '-\u00a0');
              assert.equal(await page.$eval(selector + ' li', el => getComputedStyle(el, '::before').content), 'none');
              await page.click(selector + ' > p');
              await page.waitForFunction(s => !document.querySelector(s + ' .vmd-li-marker'), {}, selector);
              assert.equal(await page.$eval(selector + ' li', el => getComputedStyle(el, '::before').content), '"• "');
              assert.match(await page.evaluate(() => vditor.getValue()), /^- +送上$/m);
            }
          } finally { await page.close(); }
        });
      }
    }
  });
