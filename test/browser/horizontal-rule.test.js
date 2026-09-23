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

test('--- stays editable on its line and renders as a rule when focus leaves',
  { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async t => {
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
    t.after(() => browser.close());

    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<button id="outside">outside</button><div id="app"></div>');
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

    for (const mode of ['ir', 'wysiwyg']) {
      await t.test(mode, async () => {
        const page = await browser.newPage();
        try {
          await page.goto(base);
          await page.addStyleTag({ url: base + '/resource/markdown/dist/index.css' });
          for (const file of ['js/lute/lute.min.js', 'js/i18n/zh_CN.js', 'index.min.js']) {
            await page.addScriptTag({ url: base + '/resource/markdown/dist/' + file,
              ...(file.includes('lute.min') ? { id: 'vditorLuteScript' } : {}) });
          }
          await page.evaluate(({ mode, base }) => new Promise(resolve => {
            window.vditor = new Vditor('app', {
              value: 'before', mode, i18n: VditorI18n,
              cdn: base + '/resource/markdown', height: 600,
              cache: { enable: false }, toolbar: [], after: resolve,
            });
          }), { mode, base });
          for (const file of ['list-marker.js', 'horizontal-rule.js', 'block-numbers.js']) {
            await page.addScriptTag({ url: base + '/resource/markdown/' + file });
          }
          await page.evaluate(() => {
            ListMarkerLive.install(vditor);
            HorizontalRuleLive.install(vditor, { sourceText: 'before' });
            BlockLineNumbers.install(vditor, { enabled: true, sourceText: 'before' });
            window.setTestMarkdown = source => {
              vditor.setValue(source);
              HorizontalRuleLive.setSource(source);
            };
          });
          await page.evaluate(mode => {
            const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
            const p = root.querySelector('p');
            root.focus();
            const range = document.createRange();
            range.setStart(p.firstChild, p.firstChild.textContent.length);
            range.collapse(true);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
          }, mode);
          await page.keyboard.press('Enter');
          await page.keyboard.type('---');
          assert.equal(await page.$eval(`.vditor-${mode} .vditor-reset > p:last-of-type`,
            p => p.textContent), '---');
          await page.click('#outside');
          await page.waitForSelector(`.vditor-${mode} .vditor-reset > hr`, { timeout: 1000 });
          const result = await page.evaluate(mode => ({
            html: document.querySelector(`.vditor-${mode} .vditor-reset`).innerHTML,
            markdown: vditor.getValue(),
            hrCount: document.querySelectorAll(`.vditor-${mode} .vditor-reset > hr`).length,
          }), mode);
          assert.equal(result.hrCount, 1, JSON.stringify(result));
          assert.equal(result.markdown, 'before\n\n---\n');
          await page.evaluate(() => BlockLineNumbers.setSource(vditor.getValue()));
          await page.waitForSelector(`.vditor-${mode} .vditor-reset > hr[data-lineno="3"]`,
            { timeout: 1000 });

          await page.click(`.vditor-${mode} .vditor-reset > hr`);
          const editing = await page.evaluate(mode => {
            const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
            const paragraph = root.querySelector('p:last-of-type');
            return {
              text: paragraph && paragraph.textContent,
              hrCount: root.querySelectorAll(':scope > hr').length,
              caretInside: paragraph && paragraph.contains(getSelection().anchorNode),
              markdown: vditor.getValue(),
            };
          }, mode);
          assert.deepEqual(editing, {
            text: '---', hrCount: 0, caretInside: true, markdown: 'before\n\n---\n',
          });
          await page.click('#outside');
          await page.waitForSelector(`.vditor-${mode} .vditor-reset > hr`, { timeout: 1000 });

          await page.evaluate(() => setTestMarkdown('before\n\n---\n\nafter'));
          await page.click(`.vditor-${mode} .vditor-reset > hr`);
          assert.equal(await page.$eval(`.vditor-${mode} .vditor-reset > p:nth-last-of-type(2)`,
            p => p.textContent), '---');
          await page.click(`.vditor-${mode} .vditor-reset > p:last-of-type`);
          await page.waitForSelector(`.vditor-${mode} .vditor-reset > hr`, { timeout: 1000 });
          assert.equal(await page.evaluate(() => vditor.getValue()), 'before\n\n---\n\nafter\n');

          const selectionLatency = await page.evaluate(mode => {
            const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
            root.innerHTML = '<p data-block="0">x</p>'.repeat(5000);
            root.focus();
            const range = document.createRange();
            range.setStart(root.firstElementChild.firstChild, 1);
            range.collapse(true);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
            const started = performance.now();
            for (let i = 0; i < 20; i++) {
              document.dispatchEvent(new Event('selectionchange'));
            }
            return performance.now() - started;
          }, mode);
          assert.ok(selectionLatency < 150,
            `${mode}: 20 selection changes took ${selectionLatency.toFixed(1)} ms in a 5000-paragraph document`);

          for (const marker of ['***', '___', '- - -', '----']) {
            await page.evaluate(source => setTestMarkdown(source), `before\n\n${marker}\n\nafter`);
            await page.click(`.vditor-${mode} .vditor-reset > hr`);
            assert.deepEqual(await page.evaluate(mode => ({
              hrCount: document.querySelectorAll(`.vditor-${mode} .vditor-reset > hr`).length,
              rawTripleDash: Array.from(document.querySelectorAll(`.vditor-${mode} .vditor-reset > p`))
                .some(p => p.textContent === '---'),
            }), mode), { hrCount: 1, rawTripleDash: false }, `${mode}: ${marker}`);
          }
          await page.evaluate(() => setTestMarkdown('before\n\n***\n\nmiddle\n\n---\n\nafter'));
          await page.click(`.vditor-${mode} .vditor-reset > hr:first-of-type`);
          assert.equal(await page.$$eval(`.vditor-${mode} .vditor-reset > hr`, rules => rules.length), 2);
          await page.click(`.vditor-${mode} .vditor-reset > hr:last-of-type`);
          assert.equal(await page.$$eval(`.vditor-${mode} .vditor-reset > hr`, rules => rules.length), 1);
          assert.ok(await page.$$eval(`.vditor-${mode} .vditor-reset > p`,
            paragraphs => paragraphs.some(p => p.textContent === '---')));

          await page.evaluate(() => setTestMarkdown('1\n\n---\n\n2'));
          const ruleBox = await page.$eval(`.vditor-${mode} .vditor-reset > hr`, element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, height: rect.height };
          });
          await page.mouse.click(ruleBox.x - 2, ruleBox.y + ruleBox.height / 2);
          await page.waitForFunction(mode => {
            const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
            return Array.from(root.querySelectorAll(':scope > p')).some(p => p.textContent === '---');
          }, { timeout: 1000 }, mode);
          assert.equal(await page.$eval(`.vditor-${mode} .vditor-reset > p:nth-last-of-type(2)`,
            p => p.textContent), '---');
          await page.click('#outside');
          await page.waitForSelector(`.vditor-${mode} .vditor-reset > hr`, { timeout: 1000 });

          await page.mouse.click(ruleBox.x + 30, ruleBox.y + ruleBox.height + 4);
          await page.waitForFunction(mode => {
            const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
            return Array.from(root.querySelectorAll(':scope > p')).some(p => p.textContent === '---');
          }, { timeout: 1000 }, mode);
          await page.click('#outside');
          await page.waitForSelector(`.vditor-${mode} .vditor-reset > hr`, { timeout: 1000 });

          await page.evaluate(mode => {
            const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
            const rule = root.querySelector(':scope > hr');
            const range = document.createRange();
            root.focus();
            range.setStart(root, Array.prototype.indexOf.call(root.childNodes, rule) + 1);
            range.collapse(true);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
          }, mode);
          await page.waitForFunction(mode => {
            const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
            return Array.from(root.querySelectorAll(':scope > p')).some(p => p.textContent === '---');
          }, { timeout: 1000 }, mode);
          await page.click('#outside');
          await page.waitForSelector(`.vditor-${mode} .vditor-reset > hr`, { timeout: 1000 });

          await page.evaluate(() => setTestMarkdown('before\n\n---\n\nafter'));

          await page.click(`.vditor-${mode} .vditor-reset > hr`);
          await page.evaluate(mode => {
            const paragraphs = document.querySelectorAll(`.vditor-${mode} .vditor-reset > p`);
            const range = document.createRange();
            range.setStart(paragraphs[0].firstChild, 0);
            range.setEnd(paragraphs[2].firstChild, paragraphs[2].textContent.length);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
          }, mode);
          await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
          assert.equal(await page.$eval(`.vditor-${mode} .vditor-reset > p:nth-last-of-type(2)`,
            p => p.textContent), '---');

          await page.click('#outside');
          await page.waitForSelector(`.vditor-${mode} .vditor-reset > hr`, { timeout: 1000 });
          await page.click(`.vditor-${mode} .vditor-reset > hr`);
          await page.keyboard.press('Backspace');
          await page.keyboard.press('Backspace');
          await page.keyboard.press('Backspace');
          await page.keyboard.type('plain');
          await page.click(`.vditor-${mode} .vditor-reset > p:last-of-type`);
          assert.deepEqual(await page.evaluate(mode => ({
            markdown: vditor.getValue(),
            hrCount: document.querySelectorAll(`.vditor-${mode} .vditor-reset > hr`).length,
          }), mode), { markdown: 'before\n\nplain\n\nafter\n', hrCount: 0 });

          await page.evaluate(() => setTestMarkdown('before\n\nafter'));
          await page.evaluate(mode => {
            const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
            const before = root.querySelector('p');
            root.focus();
            const range = document.createRange();
            range.selectNodeContents(before);
            range.collapse(false);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
          }, mode);
          await page.keyboard.press('Enter');
          await page.keyboard.type('---');
          assert.equal(await page.evaluate(() => vditor.getValue()), 'before\n\n---\n\nafter\n');
          await page.click(`.vditor-${mode} .vditor-reset > p:last-of-type`);
          await page.waitForSelector(`.vditor-${mode} .vditor-reset > hr`, { timeout: 1000 });
          assert.equal(await page.evaluate(() => vditor.getValue()), 'before\n\n---\n\nafter\n');
        } finally { await page.close(); }
      });
    }
  });
