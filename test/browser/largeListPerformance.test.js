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
].find(candidate => fs.existsSync(candidate));

test('large list plain-text input stays responsive in both editor modes',
    { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async t => {
        const { default: puppeteer } = await import('puppeteer-core');
        const server = http.createServer((req, res) => {
            if (req.url === '/') {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end('<div id="app"></div>');
                return;
            }
            const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0]));
            if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
            fs.readFile(file, (error, body) => {
                if (error) { res.writeHead(404).end(); return; }
                res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
                res.end(body);
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
        const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
        t.after(() => browser.close());
        const base = `http://127.0.0.1:${server.address().port}`;
        const markdown = Array.from({ length: 2000 }, (_, i) => `- item ${i}: ${'text '.repeat(8)}`).join('\n');

        for (const mode of ['wysiwyg', 'ir']) {
            await t.test(mode, async () => {
                const page = await browser.newPage();
                try {
                    await page.goto(base);
                    await page.addStyleTag({ url: base + '/vditor/dist/index.css' });
                    await page.addScriptTag({ url: base + '/vditor/dist/js/lute/lute.min.js', id: 'vditorLuteScript' });
                    await page.addScriptTag({ url: base + '/vditor/dist/js/i18n/en_US.js' });
                    await page.addScriptTag({ url: base + '/vditor/dist/index.min.js' });
                    await page.evaluate(({ mode, base, markdown }) => new Promise(resolve => {
                        window.vditor = new Vditor('app', {
                            value: markdown, mode, i18n: VditorI18n,
                            cdn: base + '/vditor', cache: { enable: false }, toolbar: [],
                            after() { resolve(); },
                        });
                    }), { mode, base, markdown });
                    await page.evaluate(mode => {
                        const list = document.querySelector(`.vditor-${mode} .vditor-reset > ul`);
                        const walker = document.createTreeWalker(list.querySelector('li'), NodeFilter.SHOW_TEXT);
                        let node;
                        while ((node = walker.nextNode()) && !node.nodeValue.includes('item 0')) {}
                        const position = node.nodeValue.indexOf('text') + 2;
                        const editor = document.querySelector(`.vditor-${mode} .vditor-reset`);
                        editor.focus();
                        const range = document.createRange();
                        range.setStart(node, position);
                        range.collapse(true);
                        getSelection().removeAllRanges();
                        getSelection().addRange(range);
                        window.testList = list;
                        let start;
                        editor.addEventListener('input', () => { start = performance.now(); }, true);
                        editor.addEventListener('input', () => { window.inputElapsed = performance.now() - start; });
                    }, mode);
                    await page.keyboard.type('-');
                    const result = await page.evaluate(() => {
                        const value = vditor.getValue();
                        return { elapsed: window.inputElapsed, connected: window.testList.isConnected, saved: value.includes('item 0: te-xt text') };
                    });
                    console.log(mode, `${result.elapsed.toFixed(1)} ms`);
                    assert.equal(result.saved, true);
                    assert.equal(result.connected, true);
                    assert.ok(result.elapsed < 200, `input took ${result.elapsed.toFixed(1)} ms`);
                } finally {
                    await page.close();
                }
            });
        }
    });
