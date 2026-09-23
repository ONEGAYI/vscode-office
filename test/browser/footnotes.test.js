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
const markdown = '- Parent\n- Item[^xx]\n\n'
  + Array.from({ length: 24 }, (_, index) => `Paragraph ${index}: ${'long text '.repeat(12)}`).join('\n\n')
  + `\n\n[^xx]: 脚注内容：${'示例说明和补充细节。'.repeat(18)}\n`;

test('footnote click, return, and list indentation keep the reference usable',
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
          await page.goto(base);
          await page.addStyleTag({ url: base + '/vditor/dist/index.css' });
          for (const file of ['js/lute/lute.min.js', 'js/i18n/zh_CN.js', 'index.min.js']) {
            await page.addScriptTag({ url: base + '/vditor/dist/' + file,
              ...(file.includes('lute.min') ? { id: 'vditorLuteScript' } : {}) });
          }
          await page.evaluate(({ mode, base, markdown }) => new Promise(resolve => {
            window.linkActions = [];
            window.vditor = new Vditor('app', {
              value: markdown, mode,
              i18n: VditorI18n, cdn: base + '/vditor', height: 300,
              cache: { enable: false }, toolbar: ['indent', 'outdent'],
              onLinkClick(payload) { window.linkActions.push(`${payload.type}:${payload.action}`); },
              after: resolve,
            });
          }), { mode, base, markdown });
          const root = `.vditor-${mode} .vditor-reset`;
          const backSelector = `.vditor-${mode} > .vditor-footnotes__goto-ref`;
          assert.equal(await page.$$eval(root + ' [data-type="footnotes-ref"]', els => els.length), 1);
          await page.waitForSelector(backSelector, { timeout: 1500 });
          assert.equal(await page.$eval(backSelector, el => el.textContent), '↩',
            'footnote definition always has an icon-only return action');
          const ordinaryInputMeasurements = await page.evaluate(async rootSelector => {
            const editor = document.querySelector(rootSelector);
            const definition = editor.querySelector('[data-type="footnotes-def"], [data-type="footnotes-li"]');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            let reads = 0;
            const originalRect = definition.getBoundingClientRect.bind(definition);
            definition.getBoundingClientRect = () => { reads++; return originalRect(); };
            const paragraphText = editor.querySelector('p').firstChild;
            const originalText = paragraphText.data;
            paragraphText.data += 'x';
            paragraphText.data = originalText;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            definition.getBoundingClientRect = originalRect;
            return reads;
          }, root);
          assert.equal(ordinaryInputMeasurements, 0,
            'same-line ordinary text changes should not measure every footnote');
          await page.$eval(root, editor => { editor.scrollTop = editor.scrollHeight; });
          await page.waitForFunction(selector => !document.querySelector(selector).hidden, {}, backSelector);
          await page.click(backSelector);
          assert.ok(await page.$eval(root, editor => editor.scrollTop) < 100,
            'permanent arrow returns to the first reference before any jump');
          await page.click(root + ' [data-type="footnotes-ref"]');
          assert.deepEqual(await page.evaluate(() => window.linkActions), ['footnote-ref:click'],
            'plain click is delivered even when the host registers onLinkClick');
          assert.ok(await page.$eval(root, editor => editor.scrollTop) > 100,
            'plain click scrolls to footnote definition');
          await page.$eval(root, editor => { editor.scrollTop = editor.scrollHeight; });
          await page.waitForFunction(selector => !document.querySelector(selector).hidden, {}, backSelector);
          const returnPlacement = await page.evaluate(({ rootSelector, buttonSelector }) => {
            const editor = document.querySelector(rootSelector);
            const definition = editor.querySelector('[data-type="footnotes-def"], [data-type="footnotes-li"]');
            const button = document.querySelector(buttonSelector);
            const editorRect = editor.getBoundingClientRect();
            const walker = document.createTreeWalker(definition, NodeFilter.SHOW_TEXT);
            let lastText;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (node.textContent.trim()) lastText = node;
            }
            const range = document.createRange();
            range.setStart(lastText, lastText.textContent.length - 1);
            range.setEnd(lastText, lastText.textContent.length);
            const textRect = range.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            return {
              gap: buttonRect.left - textRect.right,
              verticalDelta: Math.abs((buttonRect.top + buttonRect.bottom) / 2 - (textRect.top + textRect.bottom) / 2),
              visible: buttonRect.top >= editorRect.top && buttonRect.bottom <= editorRect.bottom,
            };
          }, { rootSelector: root, buttonSelector: backSelector });
          assert.ok(returnPlacement.gap >= 0 && returnPlacement.gap <= 12,
            `return arrow must follow the last footnote glyph: ${JSON.stringify(returnPlacement)}`);
          assert.ok(returnPlacement.verticalDelta < 12,
            `return arrow must share the last footnote line: ${JSON.stringify(returnPlacement)}`);
          assert.ok(returnPlacement.visible, 'return action must be visible in the editor viewport');
          await page.setViewport({ width: 640, height: 700 });
          await page.waitForFunction(({ rootSelector, buttonSelector }) => {
            const definition = document.querySelector(rootSelector + ' [data-type="footnotes-def"], '
              + rootSelector + ' [data-type="footnotes-li"]');
            const walker = document.createTreeWalker(definition, NodeFilter.SHOW_TEXT);
            let lastText;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (node.textContent.trim()) lastText = node;
            }
            const range = document.createRange();
            range.setStart(lastText, lastText.textContent.length - 1);
            range.setEnd(lastText, lastText.textContent.length);
            const lastRect = range.getBoundingClientRect();
            const buttonRect = document.querySelector(buttonSelector).getBoundingClientRect();
            return Math.abs(buttonRect.left - lastRect.right - 5) < 2
              && Math.abs((buttonRect.top + buttonRect.bottom - lastRect.top - lastRect.bottom) / 2) < 12;
          }, { timeout: 1500 }, { rootSelector: root, buttonSelector: backSelector });
          const beforeDefinitionLeft = await page.$eval(root + ' [data-type="footnotes-def"], ' + root + ' [data-type="footnotes-li"]',
            el => el.getBoundingClientRect().left);
          await page.evaluate(rootSelector => {
            window.blockFootnoteScroll = event => event.stopImmediatePropagation();
            document.querySelector(rootSelector).addEventListener('scroll', window.blockFootnoteScroll, true);
          }, root);
          await page.addStyleTag({ content: '.vditor-ir [data-type="footnotes-def"], '
            + '.vditor-wysiwyg [data-type="footnotes-li"] { transform: translateX(40px); }' });
          const afterDefinitionLeft = await page.$eval(root + ' [data-type="footnotes-def"], ' + root + ' [data-type="footnotes-li"]',
            el => el.getBoundingClientRect().left);
          assert.ok(Math.abs(afterDefinitionLeft - beforeDefinitionLeft - 40) < 2,
            'the custom CSS must move the footnote to exercise the positioning contract');
          await page.waitForFunction(({ rootSelector, buttonSelector }) => {
            const definition = document.querySelector(rootSelector + ' [data-type="footnotes-def"], '
              + rootSelector + ' [data-type="footnotes-li"]');
            const walker = document.createTreeWalker(definition, NodeFilter.SHOW_TEXT);
            let lastText;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (node.textContent.trim()) lastText = node;
            }
            const range = document.createRange();
            range.setStart(lastText, lastText.textContent.length - 1);
            range.setEnd(lastText, lastText.textContent.length);
            return Math.abs(document.querySelector(buttonSelector).getBoundingClientRect().left
              - range.getBoundingClientRect().right - 5) < 2;
          }, { timeout: 1500 }, { rootSelector: root, buttonSelector: backSelector });
          await page.evaluate(rootSelector => {
            document.querySelector(rootSelector).removeEventListener('scroll', window.blockFootnoteScroll, true);
            delete window.blockFootnoteScroll;
          }, root);
          await page.$eval(root, editor => { editor.scrollTop = 0; });
          await page.waitForFunction(selector => document.querySelector(selector).hidden, {}, backSelector);
          await page.$eval(root, editor => { editor.scrollTop = editor.scrollHeight; });
          await page.waitForFunction(selector => !document.querySelector(selector).hidden, {}, backSelector);
          assert.ok(!await page.evaluate(() => vditor.getValue().includes('返回引用处')),
            'return control stays outside saved Markdown');
          assert.equal(await page.$eval(backSelector, el => el.getAttribute('aria-label')),
            '返回引用处');
          await page.click(backSelector);
          assert.ok(await page.$eval(root, el => el.scrollTop) < 100, 'return action scrolls to clicked reference');
          assert.ok(await page.$(backSelector), 'return arrow remains after use');

          await page.click(root + ' li:nth-child(2)');
          await page.click('[data-type="indent"]');
          const after = await page.evaluate(root => ({
            value: vditor.getValue(),
            refs: document.querySelectorAll(root + ' [data-type="footnotes-ref"]').length,
          }), root);
          assert.equal(after.refs, 1, 'indent retains rendered footnote reference');
          assert.match(after.value, /Item\[\^xx\]/, 'indent retains Markdown footnote reference');
          await page.click(root + ' ul ul li');
          await page.click('[data-type="outdent"]');
          assert.equal(await page.$$eval(root + ' [data-type="footnotes-ref"]', els => els.length), 1,
            'outdent retains rendered footnote reference');
          assert.match(await page.evaluate(() => vditor.getValue()), /Item\[\^xx\]/);
          await page.evaluate(rootSelector => {
            const editor = document.querySelector(rootSelector);
            const item = editor.querySelector('ul > li:nth-child(2)');
            editor.focus();
            const range = document.createRange();
            range.setStart(item.firstChild, 0);
            range.collapse(true);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
          }, root);
          await page.keyboard.press('Tab');
          assert.equal(await page.$$eval(root + ' ul ul [data-type="footnotes-ref"]', els => els.length), 1,
            'Tab indentation retains rendered footnote reference');
          await page.keyboard.down('Shift');
          await page.keyboard.press('Tab');
          await page.keyboard.up('Shift');
          assert.equal(await page.$$eval(root + ' [data-type="footnotes-ref"]', els => els.length), 1,
            'Shift+Tab outdent retains rendered footnote reference');
          assert.equal(await page.$$eval(root + ' ul ul li', els => els.length), 0,
            'Shift+Tab returns the item to its original list level');
          await page.evaluate(() => vditor.setValue(vditor.getValue()));
          assert.equal(await page.$$eval(root + ' [data-type="footnotes-ref"]', els => els.length), 1,
            'footnote reference survives reopening saved Markdown');
          await page.waitForSelector(backSelector);
          assert.equal(await page.$eval(backSelector, el => el.textContent), '↩',
            'return arrow survives re-rendering');

          await page.evaluate(() => vditor.setValue('First[^xx]\n\n'
            + Array.from({ length: 16 }, (_, index) => `Middle ${index}: ${'text '.repeat(20)}`).join('\n\n')
            + '\n\nSecond[^xx]\n\n'
            + Array.from({ length: 16 }, (_, index) => `Later ${index}: ${'text '.repeat(20)}`).join('\n\n')
            + '\n\n[^xx]: Definition\n'));
          await page.waitForFunction(({ rootSelector, buttonSelector }) =>
            document.querySelectorAll(rootSelector + ' [data-type="footnotes-ref"]').length === 2
              && document.querySelectorAll(buttonSelector).length === 1,
          {}, { rootSelector: root, buttonSelector: backSelector });
          const repeatedReferences = await page.$$(root + ' [data-type="footnotes-ref"]');
          await repeatedReferences[1].click();
          await page.click(backSelector);
          const returnedToSecond = await page.evaluate(rootSelector => {
            const editor = document.querySelector(rootSelector).getBoundingClientRect();
            const references = document.querySelectorAll(rootSelector + ' [data-type="footnotes-ref"]');
            const first = references[0].getBoundingClientRect();
            const second = references[1].getBoundingClientRect();
            return second.top >= editor.top && second.bottom <= editor.bottom
              && (first.bottom < editor.top || first.top > editor.bottom);
          }, root);
          assert.ok(returnedToSecond, 'return arrow goes back to the most recently clicked reference');
          assert.equal(await page.$$eval(backSelector, els => els.length), 1,
            'one permanent arrow serves repeated references to the same footnote');

          await page.evaluate(() => vditor.setValue('Short[^xx]\n\n[^xx]: Definition\n'));
          await page.waitForSelector(backSelector);
          const shortLayout = await page.evaluate(async ({ rootSelector, buttonSelector }) => {
            const editor = document.querySelector(rootSelector);
            editor.scrollTop = 0;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const footnoteBlock = editor.querySelector('[data-type="footnotes-block"]');
            const button = document.querySelector(buttonSelector);
            const before = { definitionTop: footnoteBlock.getBoundingClientRect().top,
              buttonTop: button.getBoundingClientRect().top, scrollHeight: editor.scrollHeight };
            const extra = document.createElement('p');
            extra.textContent = 'Added above footnote';
            footnoteBlock.before(extra);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const after = { definitionTop: footnoteBlock.getBoundingClientRect().top,
              buttonTop: button.getBoundingClientRect().top, scrollHeight: editor.scrollHeight };
            return { before, after };
          }, { rootSelector: root, buttonSelector: backSelector });
          assert.equal(shortLayout.after.scrollHeight, shortLayout.before.scrollHeight,
            'short document must keep a fixed scrollHeight in this regression case');
          assert.ok(shortLayout.after.definitionTop - shortLayout.before.definitionTop > 10,
            'the added paragraph must move the footnote');
          assert.ok(Math.abs((shortLayout.after.buttonTop - shortLayout.before.buttonTop)
            - (shortLayout.after.definitionTop - shortLayout.before.definitionTop)) < 2,
          'return arrow must follow a footnote moved by earlier block insertion');

          const trailingTextGap = await page.evaluate(async ({ rootSelector, buttonSelector }) => {
            const editor = document.querySelector(rootSelector);
            const definition = editor.querySelector('[data-type="footnotes-def"], [data-type="footnotes-li"]');
            const paragraph = definition.querySelector('p');
            const tail = document.createTextNode(' ');
            paragraph.appendChild(tail);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            tail.data = ' more';
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const range = document.createRange();
            range.setStart(tail, tail.data.length - 1);
            range.setEnd(tail, tail.data.length);
            return document.querySelector(buttonSelector).getBoundingClientRect().left
              - range.getBoundingClientRect().right;
          }, { rootSelector: root, buttonSelector: backSelector });
          assert.ok(trailingTextGap >= 0 && trailingTextGap <= 12,
            `return arrow must follow newly typed trailing text: gap ${trailingTextGap}`);

          await page.setViewport({ width: 640, height: 220 });
          await page.evaluate(() => vditor.setValue('Short[^xx]\n\n[^xx]: Definition\n'));
          await page.waitForSelector(backSelector);
          const tallEditorLayout = await page.evaluate(async ({ rootSelector, buttonSelector }) => {
            const editor = document.querySelector(rootSelector);
            const definition = editor.querySelector('[data-type="footnotes-def"], [data-type="footnotes-li"]');
            const button = document.querySelector(buttonSelector);
            const text = editor.querySelector('p').firstChild;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const before = { definitionTop: definition.getBoundingClientRect().top,
              buttonTop: button.getBoundingClientRect().top, scrollHeight: editor.scrollHeight,
              clientHeight: editor.clientHeight, viewportHeight: innerHeight };
            text.data += ' extra text'.repeat(12);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const after = { definitionTop: definition.getBoundingClientRect().top,
              buttonTop: button.getBoundingClientRect().top, scrollHeight: editor.scrollHeight };
            return { before, after };
          }, { rootSelector: root, buttonSelector: backSelector });
          assert.ok(tallEditorLayout.before.clientHeight > tallEditorLayout.before.viewportHeight,
            'fixed editor must be taller than the viewport in this regression case');
          assert.equal(tallEditorLayout.after.scrollHeight, tallEditorLayout.before.scrollHeight,
            'wrapped short content must leave the fixed scrollHeight unchanged');
          assert.ok(tallEditorLayout.after.definitionTop - tallEditorLayout.before.definitionTop > 10,
            'wrapping above the footnote must move its definition');
          assert.ok(Math.abs((tallEditorLayout.after.buttonTop - tallEditorLayout.before.buttonTop)
            - (tallEditorLayout.after.definitionTop - tallEditorLayout.before.definitionTop)) < 2,
          `return arrow must follow wrapping in a fixed editor taller than the viewport: ${JSON.stringify(tallEditorLayout)}`);
          await page.setViewport({ width: 640, height: 700 });

          await page.evaluate(() => vditor.setValue('A[^aa]\n\nB[^bb]\n\n[^aa]: First\n[^bb]: Second\n'));
          await page.waitForFunction(selector => document.querySelectorAll(selector).length === 2,
            {}, backSelector);
          const secondDefinitionGap = await page.evaluate(async ({ rootSelector, buttonSelector }) => {
            const editor = document.querySelector(rootSelector);
            const definitions = editor.querySelectorAll('[data-type="footnotes-def"], [data-type="footnotes-li"]');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            definitions[0].querySelector('p').appendChild(document.createTextNode(' added'));
            const secondTail = document.createTextNode(' added');
            definitions[1].querySelector('p').appendChild(secondTail);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const range = document.createRange();
            range.setStart(secondTail, secondTail.data.length - 1);
            range.setEnd(secondTail, secondTail.data.length);
            return document.querySelectorAll(buttonSelector)[1].getBoundingClientRect().left
              - range.getBoundingClientRect().right;
          }, { rootSelector: root, buttonSelector: backSelector });
          assert.ok(secondDefinitionGap >= 0 && secondDefinitionGap <= 12,
            `all definitions changed in one mutation batch must refresh: gap ${secondDefinitionGap}`);

          await page.evaluate(() => vditor.setValue('Plain paragraph\n'));
          await page.waitForFunction(selector => document.querySelectorAll(selector).length === 0,
            {}, backSelector);
          await page.evaluate(() => vditor.setValue('New[^yy]\n\n[^yy]: Added footnote\n'));
          await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1,
            {}, backSelector);
          await page.evaluate(() => vditor.destroy());
          assert.equal(await page.$$eval(backSelector, els => els.length), 0,
            'destroy removes the permanent return action');
        } finally { await page.close(); }
      });
    }
  });
