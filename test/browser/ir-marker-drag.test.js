'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '../..');
// Run npm run build first; BROWSER_PATH can select a standalone Chromium build.
const browserPath = process.env.BROWSER_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));

test('native editor text drag updates rendering and history',
  { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async t => {
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
    t.after(() => browser.close());
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
    const base = `http://127.0.0.1:${server.address().port}`;
    const cases = [
      { marker: '**', tag: 'strong' },
      { marker: '*', tag: 'em' },
      { marker: '~~', tag: 's' },
      { marker: '`', tag: 'code' },
      { plain: true, mode: 'ir' },
      { plain: true, mode: 'wysiwyg' },
      { marker: '**', tag: 'strong', crossBlock: true },
    ];
    for (const scenario of cases) {
      for (const hosted of [false, true]) {
        const { marker, tag, plain, crossBlock, mode = 'ir' } = scenario;
        const original = plain ? 'abcdef' : `first${marker}of${marker}word${crossBlock ? '\n\nnext' : ''}`;
        const expected = plain ? 'adebcf' : crossBlock ? `first${marker}ofword\n\nn${marker}ext`
          : `first${marker}ofw${marker}ord`;
        const name = `${mode} ${plain ? 'plain text' : marker}${crossBlock ? ' across paragraphs' : ''}`;
        await t.test(`${name} ${hosted ? 'inside VSCode drop guards' : 'standalone'}`, async () => {
          const page = await browser.newPage();
          try {
            page.setDefaultTimeout(5000);
            await page.goto(base);
            if (hosted) {
              // VSCode's webview preload cancels bubbling dragover/drop events on window.
              await page.evaluate(() => {
                window.addEventListener('dragover', event => event.preventDefault());
                window.addEventListener('drop', event => event.preventDefault());
              });
            }
            await page.addStyleTag({ url: base + '/resource/markdown/dist/index.css' });
            for (const file of ['js/lute/lute.min.js', 'js/i18n/en_US.js', 'index.min.js']) {
              await page.addScriptTag({ url: base + '/resource/markdown/dist/' + file,
                ...(file.includes('lute.min') ? { id: 'vditorLuteScript' } : {}) });
            }
            await page.evaluate(({ base, original, mode }) => new Promise(resolve => {
              window.changes = [];
              window.events = [];
              window.vditor = new Vditor('app', {
                value: original, mode, i18n: VditorI18n,
                cdn: base + '/resource/markdown', height: 400,
                cache: { enable: false }, undoDelay: 50, toolbar: ['bold', 'undo', 'redo'],
                input: value => changes.push(value.trim()), after: resolve,
              });
            }), { base, original, mode });
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
            const points = await page.evaluate(({ tag, plain, crossBlock, mode }) => {
              const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
              root.focus();
              const range = document.createRange();
              const target = document.createRange();
              if (plain) {
                const text = root.querySelector('p').firstChild;
                range.setStart(text, 1); range.setEnd(text, 3);
                target.setStart(text, 5);
              } else {
                const styled = root.querySelector(tag);
                range.selectNodeContents(styled);
                range.collapse(true);
                getSelection().removeAllRanges(); getSelection().addRange(range);
                styled.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                range.selectNodeContents(styled.nextElementSibling);
                target.setStart(crossBlock ? root.querySelectorAll('p')[1].firstChild
                  : styled.parentElement.nextSibling, 1);
              }
              getSelection().removeAllRanges(); getSelection().addRange(range);
              const source = range.getBoundingClientRect();
              target.collapse(true);
              const dest = target.getBoundingClientRect();
              for (const type of ['dragstart', 'drop', 'input', 'dragend']) {
                root.addEventListener(type, event => events.push(event.inputType || event.type));
              }
              return { from: { x: source.x + source.width / 2, y: source.y + source.height / 2 },
                to: { x: dest.x, y: dest.y + dest.height / 2 } };
            }, { tag, plain, crossBlock, mode });
            await page.mouse.move(points.from.x, points.from.y);
            await page.mouse.down();
            await page.mouse.move(points.from.x + 5, points.from.y, { steps: 5 });
            await page.mouse.move(points.to.x, points.to.y, { steps: 15 });
            await page.mouse.up();
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
            const result = await page.evaluate(({ mode, tag }) => ({
              markdown: vditor.getValue().trim(),
              styled: tag ? document.querySelector(`.vditor-${mode} ${tag}`)?.textContent : null,
              html: document.querySelector(`.vditor-${mode} .vditor-reset`).innerHTML,
              changes, events,
            }), { mode, tag });
            assert.ok(result.events.includes('insertFromDrop'), JSON.stringify(result));
            if (!plain) assert.equal(result.styled, crossBlock ? undefined : 'ofw', JSON.stringify(result));
            assert.equal(result.markdown, expected);
            assert.equal(result.changes.at(-1), expected);
            await page.click('[data-type="undo"]');
            assert.equal(await page.evaluate(() => vditor.getValue().trim()), original, 'undo restores the whole move');
            await page.click('[data-type="redo"]');
            assert.equal(await page.evaluate(() => vditor.getValue().trim()), expected, 'redo restores the move');
          } finally {
            await page.close();
          }
        });
      }
    }
  });
