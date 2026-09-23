'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const browserPath = process.env.BROWSER_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

test('HTML clipboard event attributes stay inert in Chrome',
    { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async () => {
        const code = buildSync({
            entryPoints: [path.resolve(__dirname, '../../src/react/view/excel/x-spreadsheet/core/clipboard_html.js')],
            bundle: true, platform: 'browser', format: 'iife', globalName: 'ClipboardHtml', write: false,
        }).outputFiles[0].text;
        const { default: puppeteer } = await import('puppeteer-core');
        const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
        try {
            const page = await browser.newPage();
            await page.setContent('<!doctype html><html><body></body></html>');
            await page.addScriptTag({ content: code });
            const result = await page.evaluate(async () => {
                window.clipboardCodeExecuted = false;
                const parsed = ClipboardHtml.parseHtmlClipboard(
                    '<table><tr><td onclick="window.clipboardCodeExecuted=true">safe<img src="bad" onerror="window.clipboardCodeExecuted=true"></td></tr></table>',
                );
                await new Promise(resolve => setTimeout(resolve, 200));
                return { executed: window.clipboardCodeExecuted, text: parsed.rows[0][0].text };
            });
            assert.equal(result.executed, false);
            assert.equal(result.text, 'safe');
        } finally {
            await browser.close();
        }
    });
