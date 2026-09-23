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

test('replacing code-heavy documents releases previous CodeMirror nodes',
    { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async t => {
        const { default: puppeteer } = await import('puppeteer-core');
        const server = http.createServer((req, res) => {
            if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<div id="app"></div>'); return; }
            const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0]));
            if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
            fs.readFile(file, (error, body) => {
                if (error) { res.writeHead(404).end(); return; }
                res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
                res.end(body);
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
        const browser = await puppeteer.launch({
            executablePath: browserPath, headless: true,
            args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
        });
        t.after(() => browser.close());
        const base = `http://127.0.0.1:${server.address().port}`;
        const markdown = Array.from({ length: 80 }, (_, i) => `\`\`\`js\nconst n = ${i};\n\`\`\``).join('\n\n');

        for (const mode of ['wysiwyg', 'ir']) {
            await t.test(mode, async () => {
                const page = await browser.newPage();
                page.on('pageerror', error => console.error(error.message));
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
                    await page.evaluate(async markdown => {
                        for (let i = 0; i < 30; i += 1) {
                            vditor.setValue(markdown, true);
                            await new Promise(resolve => setTimeout(resolve, 0));
                        }
                    }, markdown);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const before = await page.evaluate(() => { gc(); return performance.memory.usedJSHeapSize; });
                    await page.evaluate(async markdown => {
                        for (let i = 0; i < 30; i += 1) {
                            vditor.setValue(markdown, true);
                            await new Promise(resolve => setTimeout(resolve, 0));
                        }
                    }, markdown);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const result = await page.evaluate(() => {
                        gc();
                        return {
                            after: performance.memory.usedJSHeapSize,
                            blocks: document.querySelectorAll(`[data-type="code-block"]`).length,
                        };
                    });
                    result.before = before;
                    console.log(mode, `${(result.after - result.before) / 1024 / 1024} MiB heap growth`);
                    assert.ok(result.blocks >= 80);
                    assert.ok(result.after - result.before < 5 * 1024 * 1024,
                        `heap grew ${(result.after - result.before) / 1024 / 1024} MiB`);
                } finally {
                    await page.close();
                }
            });
        }
    });
