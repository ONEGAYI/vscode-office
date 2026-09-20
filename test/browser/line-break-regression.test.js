'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const ROOT = path.resolve(__dirname, '../..');
const browserPath = process.env.BROWSER_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

test('line break boundary and line-number alignment',
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
    const init = async (page, mode, value = '## 送\n\n你好送饭四季春') => {
      page.setDefaultTimeout(5000);
      await page.goto(base);
      await page.evaluate(() => localStorage.clear());
      for (const file of ['dist/index.css', 'index.css']) {
        await page.addStyleTag({ url: base + '/resource/markdown/' + file });
      }
      for (const file of ['dist/js/lute/lute.min.js', 'dist/js/i18n/zh_CN.js', 'dist/index.min.js', 'block-numbers.js']) {
        await page.addScriptTag({ url: base + '/resource/markdown/' + file,
          ...(file.includes('lute.min') ? { id: 'vditorLuteScript' } : {}) });
      }
      await page.evaluate(({ base, mode, value }) => new Promise(resolve => {
        window.vditor = new Vditor('app', {
          value, mode, i18n: VditorI18n, cdn: base + '/resource/markdown', height: 500,
          cache: { enable: false }, undoDelay: 50, toolbar: ['undo', 'redo'],
          input(value) { window.savedMarkdown = value; }, after: resolve,
        });
      }), { base, mode, value });
      await page.evaluate(() => {
        BlockLineNumbers.install(vditor);
        vditor.vditor[vditor.getCurrentMode()].element.style.fontSize = '20px';
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    const shiftEnter = async page => {
      await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
      await new Promise(resolve => setTimeout(resolve, 150));
    };
    for (const level of [1, 2, 3, 4, 5, 6]) {
      for (const caret of ['text', 'marker', 'heading']) {
        await t.test(`IR: Shift+Enter before H${level} marker (${caret}) keeps caret before marker`, async () => {
          const page = await browser.newPage();
          try {
            const heading = '#'.repeat(level) + ' 送';
            await init(page, 'ir', heading + '\n\n你好送饭四季春');
            await page.evaluate(caret => {
              const root = vditor.vditor.ir.element; root.focus();
              const marker = root.querySelector('.vditor-ir__marker--heading');
              const range = document.createRange();
              range.setStart(caret === 'text' ? marker.firstChild : caret === 'marker' ? marker : marker.parentElement, 0);
              range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range);
            }, caret);
            await shiftEnter(page);
            const result = await page.evaluate(level => {
              const root = vditor.vditor.ir.element;
              const range = document.createRange(); range.selectNodeContents(root.querySelector('h' + level));
              range.setEnd(getSelection().anchorNode, getSelection().anchorOffset);
              return { prefix: range.toString(), markdown: vditor.getValue(),
                tags: [...root.children].filter(el => !el.classList.contains('vditor-editor-boundary')).map(el => el.tagName) };
            }, level);
            assert.equal(result.prefix.replace(/\u200b/g, ''), '', JSON.stringify(result));
            assert.deepEqual(result.tags, ['BR', 'H' + level, 'P']);
            assert.equal(result.markdown, '\n' + heading + '\n\n你好送饭四季春\n',
              'Shift+Enter moves the heading down exactly one source line');
            assert.equal(await page.$eval('h' + level + '[data-lineno]', el => el.getAttribute('data-lineno')), '2');
            assert.equal(await page.evaluate(() => window.savedMarkdown), result.markdown, 'host receives the single newline');
            await page.click('[data-type="undo"]');
            assert.equal(await page.evaluate(() => vditor.vditor.ir.element.querySelector(':scope > :not(.vditor-editor-boundary)').tagName), 'H' + level);
            await page.click('[data-type="redo"]');
            assert.equal(await page.evaluate(() => vditor.vditor.ir.element.querySelector(':scope > :not(.vditor-editor-boundary)').tagName), 'BR');
            assert.equal(await page.evaluate(() => vditor.getValue()), result.markdown);
            await shiftEnter(page);
            assert.equal(await page.evaluate(() => vditor.getValue()), '\n' + result.markdown,
              'each Shift+Enter adds exactly one line');
            await page.keyboard.press('Backspace');
            assert.equal(await page.evaluate(() => vditor.getValue()), result.markdown);
            await page.keyboard.press('Backspace');
            assert.equal(await page.evaluate(() => vditor.getValue()), heading + '\n\n你好送饭四季春\n');
            await shiftEnter(page);
            await page.keyboard.press('End');
            await page.keyboard.type('X');
            await new Promise(resolve => setTimeout(resolve, 150));
            assert.equal(await page.evaluate(() => vditor.getValue()), '\n' + heading + 'X\n\n你好送饭四季春\n',
              'editing the heading preserves the preceding single newline');
          } finally { await page.close(); }
        });
      }
    }
    for (const mode of ['ir', 'wysiwyg']) {
      await t.test(`${mode}: leading line break moves the number with the first text line`, async () => {
        const page = await browser.newPage();
        try {
          await init(page, mode);
          const measure = () => page.evaluate(() => {
            const paragraph = vditor.vditor[vditor.getCurrentMode()].element.querySelector('p');
            const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
            let node; while ((node = walker.nextNode()) && !node.textContent.includes('你')) {}
            const range = document.createRange();
            range.setStart(node, node.textContent.indexOf('你')); range.setEnd(node, node.textContent.indexOf('你') + 1);
            return { number: paragraph.getAttribute('data-lineno'),
              gap: paragraph.getBoundingClientRect().top + parseFloat(getComputedStyle(paragraph, '::after').top)
                - range.getBoundingClientRect().top, html: paragraph.outerHTML };
          });
          const before = await measure();
          assert.equal(before.number, '3');
          await page.evaluate(() => {
            const root = vditor.vditor[vditor.getCurrentMode()].element; root.focus();
            const range = document.createRange(); range.setStart(root.querySelector('p').firstChild, 0); range.collapse(true);
            getSelection().removeAllRanges(); getSelection().addRange(range);
          });
          await shiftEnter(page);
          const after = await measure();
          assert.equal(after.number, '4');
          assert.ok(Math.abs(after.gap - before.gap) < 1, JSON.stringify({ before, after }));
          if (process.env.LINE_BREAK_SCREENSHOT_DIR) {
            await page.screenshot({ path: path.join(process.env.LINE_BREAK_SCREENSHOT_DIR, `line-break-${mode}.png`) });
          }
          // A second leading break and a font/line-height change update the offset automatically.
          await shiftEnter(page);
          const second = await measure();
          assert.equal(second.number, '5');
          assert.ok(Math.abs(second.gap - before.gap) < 1, JSON.stringify(second));
          await page.evaluate(() => {
            const paragraph = vditor.vditor[vditor.getCurrentMode()].element.querySelector('p');
            paragraph.style.fontSize = '28px'; paragraph.style.lineHeight = '1.9';
          });
          await new Promise(resolve => setTimeout(resolve, 100));
          const resized = await measure();
          assert.ok(Math.abs(resized.gap) < 6, JSON.stringify(resized));
          assert.ok(!await page.evaluate(() => vditor.getValue().includes('--lineno')), 'positioning is presentation only');
          await page.evaluate(() => BlockLineNumbers.setEnabled(false));
          assert.equal(await page.evaluate(() => vditor.vditor[vditor.getCurrentMode()].element.querySelector('p').style.getPropertyValue('--lineno-offset')), '');
        } finally { await page.close(); }
      });
    }
  });
