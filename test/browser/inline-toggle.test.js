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

test('inline toggles preserve the caret or text selection',
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
    const assetBase = process.env.VDITOR_ASSET_BASE || base;
    const styles = [
      { type: 'bold', marker: '**', key: 'b' },
      { type: 'italic', marker: '*', key: 'i' },
      { type: 'strike', marker: '~~', key: 'd' },
      { type: 'inline-code', marker: '`', key: 'g' },
      { type: 'link', text: '[strong](https://example.com)', key: 'k' },
      { type: 'bold', text: '**left *strong* right**', expected: 'left *strong* right', before: 'left *str', key: 'b' },
      { type: 'italic', text: '***strong***', expected: '**strong**', before: '**str', key: 'i' },
      { type: 'strike', text: '**~~strong~~**', expected: '**strong**', before: '**str', key: 'd' },
      { type: 'bold', text: '[**strong**](https://example.com)', expected: '[strong](https://example.com)', before: '[str', key: 'b' },
      { type: 'link', text: '[*strong*](https://example.com)', expected: '*strong*', before: '*str', key: 'k' },
    ];
    const cases = styles.flatMap(style => style.expected ? [style]
      : [0, 3, 6].map(offset => ({ ...style, offset, before: ['','str','strong'][offset / 3] })));
    cases.push(...styles.slice(0, 5).map(style => ({ ...style, offset: 1, selected: true })));
    cases.push(...styles.slice(0, 4).map(style => ({ ...style, offset: 0, selected: true, add: true })));
    cases.push(...styles.slice(0, 4).flatMap(style => ['drag', 'paragraph'].map(gesture =>
      ({ ...style, offset: 0, selected: true, add: true, gesture }))));
    cases.push(...styles.slice(0, 4).map(style =>
      ({ ...style, offset: 3, selected: true, add: true, gesture: 'list-drag', list: true })));
    cases.push(...['ordered', 'nested'].map(list =>
      ({ ...styles[0], offset: 3, selected: true, add: true, gesture: `${list}-list-drag`, list })));
    for (const mode of ['ir', 'wysiwyg']) {
      for (const style of cases) {
        for (const trigger of style.key ? ['button', 'shortcut'] : ['button']) {
          await t.test(`${mode}: ${style.type} ${style.text || style.marker} ${style.gesture || (style.add ? 'add then remove on selection' : style.selected ? 'selected tron' : `at ${style.offset ?? 3}`)} via ${trigger}`, async () => {
            const page = await browser.newPage();
            page.setDefaultTimeout(5000);
            try {
              await page.goto(base);
              await page.addStyleTag({ url: assetBase + '/resource/markdown/dist/index.css' });
              if (style.list) {
                await page.addStyleTag({ url: assetBase + '/resource/markdown/index.css' });
                await page.addScriptTag({ url: assetBase + '/resource/markdown/list-marker.js' });
                await page.addScriptTag({ url: assetBase + '/resource/markdown/block-numbers.js' });
              }
              for (const file of ['js/lute/lute.min.js', 'js/i18n/en_US.js', 'index.min.js']) {
                await page.addScriptTag({ url: assetBase + '/resource/markdown/dist/' + file,
                  ...(file.includes('lute.min') ? { id: 'vditorLuteScript' } : {}) });
              }
              const original = style.list === 'ordered' ? '#### 我\n\n12. hello是P\n13. 的是\n14. 分从\n'
                : style.list === 'nested' ? '#### 我\n\n- 外层\n  - hello是P\n  - 的是\n  - 分从\n'
                : style.list ? '#### 我\n\n- hello是P\n- 的是\n- 分从\n'
                : `before ${style.add ? 'strong' : style.text || `${style.marker}strong${style.marker}`} after\n`;
              const expected = `before ${style.expected || 'strong'} after`;
              await page.evaluate(({ mode, base, original }) => new Promise(resolve => {
                window.vditor = new Vditor('app', {
                  value: original, mode, i18n: VditorI18n, cdn: base + '/resource/markdown',
                  height: 600, cache: { enable: false }, undoDelay: 50,
                  toolbar: ['bold', 'italic', 'strike', 'inline-code', 'link', 'undo', 'redo'],
                  after() {
                    if (window.ListMarkerLive) ListMarkerLive.install(window.vditor);
                    if (window.BlockLineNumbers) BlockLineNumbers.install(window.vditor, { enabled: true });
                    resolve();
                  },
                });
              }), { mode, base: assetBase, original });
              // The initial history snapshot is deferred by undoDelay, even after `after`.
              // Let it settle before an edit can replace that pending timer.
              await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
              const originalMarkdown = await page.evaluate(() => vditor.getValue().trim());
              await page.evaluate(({ mode, offset, selected, add, list }) => {
                const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
                root.focus();
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                  const node = walker.currentNode;
                  const index = node.textContent.indexOf(list ? 'hello是P' : 'strong');
                  if (index < 0) continue;
                  const range = document.createRange();
                  range.setStart(node, index + offset);
                  if (selected) range.setEnd(node, index + (add ? 6 : 5));
                  else range.collapse(true);
                  getSelection().removeAllRanges(); getSelection().addRange(range);
                  node.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  return;
                }
                throw new Error('Cannot place caret in strong');
              }, { mode, offset: style.offset ?? 3, selected: style.selected, add: style.add, list: style.list });
              if (style.gesture === 'paragraph') {
                await page.evaluate(mode => {
                  const range = document.createRange();
                  range.selectNodeContents(document.querySelector(`.vditor-${mode} .vditor-reset p`));
                  getSelection().removeAllRanges(); getSelection().addRange(range);
                }, mode);
              } else if (style.gesture === 'drag' || style.list) {
                const points = await page.evaluate(() => {
                  const range = getSelection().getRangeAt(0);
                  const rect = range.getBoundingClientRect();
                  return { x1: rect.left, x2: rect.right, y: rect.top + rect.height / 2 };
                });
                await page.mouse.move(points.x1, points.y);
                await page.mouse.down();
                await page.mouse.move(points.x2, points.y, { steps: 10 });
                await page.mouse.up();
              }
              await page.waitForFunction(({ type, add }) => document.querySelector(`button[data-type="${type}"]`)
                .classList.contains('vditor-menu--current') === !add, {}, { type: style.type, add: !!style.add });
              if (trigger === 'button') {
                await page.click(`button[data-type="${style.type}"]`);
              } else {
                await page.keyboard.down('Control');
                await page.keyboard.press(style.key);
                await page.keyboard.up('Control');
              }
              if (style.selected) {
                const selectedText = style.list ? 'lo是' : style.gesture === 'paragraph' ? 'before strong after' : style.add ? 'strong' : 'tron';
                assert.equal(await page.evaluate(() => getSelection().toString().replace(/\u200b/g, '')), selectedText,
                  'adding or removing the style must retain the selected text');
                await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
                assert.equal(await page.evaluate(() => getSelection().toString().replace(/\u200b/g, '')), selectedText,
                  'the history snapshot must also retain the selected text');
                if (style.add) {
                  const formatted = style.list ? originalMarkdown.replace('lo是', `${style.marker}lo是${style.marker}`) : style.gesture === 'paragraph'
                    ? `${style.marker}before strong after${style.marker}`
                    : `before ${style.marker}strong${style.marker} after`;
                  assert.equal(await page.evaluate(() => vditor.getValue().trim()), formatted,
                    'the selection must actually receive the requested style');
                  if (trigger === 'button') await page.click(`button[data-type="${style.type}"]`);
                  else {
                    await page.keyboard.down('Control');
                    await page.keyboard.press(style.key);
                    await page.keyboard.up('Control');
                  }
                  assert.equal(await page.evaluate(() => getSelection().toString().replace(/\u200b/g, '')), selectedText,
                    'toggling the same style off must retain the original selection');
                  assert.equal(await page.evaluate(() => vditor.getValue().trim()), originalMarkdown);
                }
                return;
              }
              const result = await page.evaluate(mode => {
                const root = document.querySelector(`.vditor-${mode} .vditor-reset`);
                const caret = getSelection().getRangeAt(0);
                const before = document.createRange();
                before.selectNodeContents(root);
                before.setEnd(caret.startContainer, caret.startOffset);
                return { markdown: vditor.getValue().trim(), collapsed: caret.collapsed,
                  before: before.toString().replace(/\u200b/g, '') };
              }, mode);
              assert.equal(result.markdown, expected, JSON.stringify(result));
              assert.equal(result.collapsed, true);
              const before = style.before ?? 'str';
              assert.equal(result.before, 'before ' + (mode === 'ir' ? before : before.replace(/[\[*]/g, '')),
                JSON.stringify(result));
              if (trigger === 'button' && (style.offset ?? 3) === 3) {
                await page.waitForFunction(() => !document.querySelector('button[data-type="undo"]')
                  .classList.contains('vditor-menu--disabled'));
                await page.click('button[data-type="undo"]');
                await page.waitForFunction(original => vditor.getValue().trim() === original, {}, originalMarkdown);
                await page.click('button[data-type="redo"]');
                await page.waitForFunction(expected => vditor.getValue().trim() === expected, {}, expected);
                // Redo must restore the caret as well as the visible text.
                await page.keyboard.type('X');
                assert.equal(await page.evaluate(() => vditor.getValue().trim()),
                  expected.replace('strong', 'strXong'));
              }
            } finally { await page.close(); }
          });
        }
      }
    }
  });
