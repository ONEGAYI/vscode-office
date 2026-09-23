'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { runInNewContext } = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const browserPath = process.env.BROWSER_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

test('PDF export renders Mermaid while document-owned script stays inert',
    { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async () => {
        const code = buildSync({
            entryPoints: [path.join(ROOT, 'src/service/markdown/markdown-pdf.js')],
            bundle: true, platform: 'node', format: 'cjs',
            external: ['vscode', 'puppeteer-core', 'vscode-html-to-docx', './outline'], write: false,
        }).outputFiles[0].text;
        const moduleRef = { exports: {} };
        runInNewContext(code, {
            module: moduleRef, exports: moduleRef.exports,
            require: name => name === 'vscode'
                ? { Uri: { file: file => ({ fsPath: file }) } }
                : name === './outline' ? { createOutline: async pdf => Buffer.from(pdf) }
                : require(name),
            __dirname: path.join(ROOT, 'out'),
            process, console, Buffer, setTimeout, clearTimeout,
        });
        const { default: puppeteer } = await import('puppeteer-core');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-pdf-security-'));
        const baseName = path.basename(dir);
        const input = path.join(dir, `${baseName}.md`);
        const pdf = path.join(dir, `${baseName}.pdf`);
        const html = path.join(os.tmpdir(), `${baseName}_tmp.html`);
        let browser;
        try {
            fs.writeFileSync(input,
                '<script>window.documentOwned = true</script>\n\n```mermaid\ngraph TD; A-->B\n```');
            await moduleRef.exports.convertMd({
                markdownFilePath: input,
                config: {
                    type: ['pdf'], withoutOutline: true, debug: true,
                    executablePath: browserPath,
                },
            });
            assert.ok(fs.statSync(pdf).size > 1000);
            browser = await puppeteer.launch({
                executablePath: browserPath, headless: true,
                args: ['--allow-file-access-from-files'],
            });
            const page = await browser.newPage();
            await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
            await page.waitForSelector('.mermaid svg', { timeout: 10000 });
            assert.equal(await page.evaluate(() => window.documentOwned), undefined);
        } finally {
            if (browser) await browser.close();
            for (const file of [html, pdf, input]) {
                if (fs.existsSync(file)) fs.unlinkSync(file);
            }
            fs.rmdirSync(dir);
        }
    });
