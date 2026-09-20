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

test('IR heading Enter and Backspace',
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
    for (const level of [1, 2, 3, 4, 5, 6]) {
      for (const caret of ['text', 'marker', 'heading']) {
        await t.test(`H${level}, caret at ${caret} start: preserve content and history`, async () => {
          const page = await browser.newPage();
          try {
            page.setDefaultTimeout(5000);
            await page.goto(base);
            await page.addStyleTag({ url: base + '/resource/markdown/dist/index.css' });
            for (const file of ['js/lute/lute.min.js', 'js/i18n/en_US.js', 'index.min.js']) {
              await page.addScriptTag({ url: base + '/resource/markdown/dist/' + file,
                ...(file.includes('lute.min') ? { id: 'vditorLuteScript' } : {}) });
            }
            const heading = '#'.repeat(level) + ' Heading **bold**';
            await page.evaluate(({ base, heading }) => new Promise(resolve => {
              window.changes = [];
              window.vditor = new Vditor('app', {
                value: 'placeholder\n\n' + heading, mode: 'ir', i18n: VditorI18n,
                cdn: base + '/resource/markdown', height: 400,
                cache: { enable: false }, undoDelay: 50, toolbar: ['undo', 'redo'],
                input: value => changes.push(value), after: resolve,
              });
            }), { base, heading });
            // Let the editor's initial deferred render/history setup finish before selecting text.
            await new Promise(resolve => setTimeout(resolve, 100));
            // Delete the first paragraph's text, leaving a real editable empty line.
            await page.click('.vditor-ir .vditor-reset p');
            await page.keyboard.press('Home');
            await page.keyboard.down('Shift');
            await page.keyboard.press('End');
            await page.keyboard.up('Shift');
            await page.keyboard.press('Backspace');
            await page.waitForFunction(() => document.querySelector('.vditor-ir .vditor-reset p').textContent.trim() === '');
            await page.waitForFunction(() => changes.length > 0 && !changes.at(-1).includes('placeholder'));
            const inputCount = await page.evaluate(() => changes.length);
            await page.evaluate(caret => {
              const marker = document.querySelector('.vditor-ir__marker--heading');
              const range = document.createRange();
              range.setStart(caret === 'text' ? marker.firstChild : caret === 'marker' ? marker : marker.parentElement, 0);
              range.collapse(true);
              getSelection().removeAllRanges(); getSelection().addRange(range);
            }, caret);
            await page.keyboard.press('Backspace');
            await new Promise(resolve => setTimeout(resolve, 150));
            const result = await page.evaluate(level => ({
              markdown: vditor.getValue().trim(),
              html: document.querySelector('.vditor-ir .vditor-reset').innerHTML,
              firstTag: document.querySelector('.vditor-ir .vditor-reset > :not(.vditor-editor-boundary)').tagName,
              lastInput: changes.at(-1).trim(),
              inputCount: changes.length,
              caretPrefix: (() => {
                const range = getSelection().getRangeAt(0).cloneRange();
                range.selectNodeContents(document.querySelector('.vditor-ir h' + level));
                range.setEnd(getSelection().anchorNode, getSelection().anchorOffset);
                return range.toString();
              })(),
            }), level);
            assert.equal(result.markdown, heading, JSON.stringify(result));
            assert.equal(result.firstTag, 'H' + level, JSON.stringify(result));
            assert.equal(result.lastInput, heading, 'notify the host of the edit');
            assert.ok(result.inputCount > inputCount, 'emit a new input notification');
            assert.equal(result.caretPrefix.replace(/\u200b/g, ''), '', 'keep caret before the marker');
            await page.click('[data-type="undo"]');
            assert.equal(await page.evaluate(() => document.querySelector('.vditor-ir .vditor-reset > :not(.vditor-editor-boundary)').tagName), 'P', 'undo restores the empty line');
            assert.equal(await page.evaluate(() => vditor.getValue().trim()), heading, 'undo keeps the heading');
            await page.click('[data-type="redo"]');
            assert.equal(await page.evaluate(() => document.querySelector('.vditor-ir .vditor-reset > :not(.vditor-editor-boundary)').tagName), 'H' + level, 'redo removes the empty line');
            assert.equal(await page.evaluate(() => vditor.getValue().trim()), heading);
            // Editing within the marker remains a normal character deletion.
            await page.evaluate(() => {
              const root = document.querySelector('.vditor-ir .vditor-reset');
              root.focus();
              const marker = root.querySelector('.vditor-ir__marker--heading');
              const range = document.createRange();
              range.setStart(marker.firstChild, 1);
              range.collapse(true);
              getSelection().removeAllRanges(); getSelection().addRange(range);
            });
            await page.keyboard.press('Backspace');
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.equal(await page.evaluate(() => vditor.getValue().trim()),
              (level === 1 ? '' : '#'.repeat(level - 1) + ' ') + 'Heading **bold**',
              'Backspace inside the marker still removes one #');

            await page.evaluate(heading => vditor.setValue(heading), heading);
            await new Promise(resolve => setTimeout(resolve, 100));
            const beforeEnterInputs = await page.evaluate(() => changes.length);
            await page.evaluate(caret => {
              const root = document.querySelector('.vditor-ir .vditor-reset');
              root.focus();
              const marker = root.querySelector('.vditor-ir__marker--heading');
              const range = document.createRange();
              range.setStart(caret === 'text' ? marker.firstChild : caret === 'marker' ? marker : marker.parentElement, 0);
              range.collapse(true);
              getSelection().removeAllRanges(); getSelection().addRange(range);
            }, caret);
            await page.keyboard.press('Enter');
            await new Promise(resolve => setTimeout(resolve, 150));
            const afterEnter = await page.evaluate(() => ({
              tags: Array.from(document.querySelector('.vditor-ir .vditor-reset').children)
                .filter(el => !el.classList.contains('vditor-editor-boundary')).map(el => el.tagName),
              markdown: vditor.getValue().trim(),
              html: document.querySelector('.vditor-ir .vditor-reset').innerHTML,
              inputCount: changes.length,
              lastInput: changes.at(-1).trim(),
              caretInHeading: Array.from(document.querySelectorAll('.vditor-ir h1,.vditor-ir h2,.vditor-ir h3,.vditor-ir h4,.vditor-ir h5,.vditor-ir h6'))
                .some(el => el.contains(getSelection().anchorNode)),
            }));
            assert.equal(afterEnter.markdown, heading, 'Enter preserves the Markdown heading');
            assert.deepEqual(afterEnter.tags, ['P', 'H' + level],
              'Enter inserts a plain empty paragraph, not a phantom heading: ' + afterEnter.html);
            assert.ok(afterEnter.inputCount > beforeEnterInputs, 'Enter notifies the host');
            assert.equal(afterEnter.lastInput, heading);
            assert.ok(afterEnter.caretInHeading, 'Enter keeps the caret in the original heading');
            await page.click('[data-type="undo"]');
            assert.equal(await page.evaluate(() => document.querySelector('.vditor-ir .vditor-reset > :not(.vditor-editor-boundary)').tagName), 'H' + level, 'undo Enter removes the blank line');
            await page.click('[data-type="redo"]');
            assert.equal(await page.evaluate(() => document.querySelector('.vditor-ir .vditor-reset > :not(.vditor-editor-boundary)').tagName), 'P', 'redo Enter restores a plain blank line');
            await page.evaluate(() => {
              const root = document.querySelector('.vditor-ir .vditor-reset');
              root.focus();
              const range = document.createRange();
              range.setStart(root.querySelector('.vditor-ir__marker--heading').firstChild, 0);
              range.collapse(true);
              getSelection().removeAllRanges(); getSelection().addRange(range);
            });
            await page.keyboard.press('Backspace');
            assert.equal(await page.evaluate(() => document.querySelector('.vditor-ir .vditor-reset > :not(.vditor-editor-boundary)').tagName), 'H' + level, 'Backspace removes the Enter-created blank line');
            assert.equal(await page.evaluate(() => vditor.getValue().trim()), heading);
          } finally { await page.close(); }
        });
      }
    }
  });
