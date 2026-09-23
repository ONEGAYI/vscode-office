'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const browserPath = process.env.BROWSER_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

test('long inline tooltip wraps and stays inside the editor viewport',
  { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async t => {
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setViewport({ width: 950, height: 400 });
    await page.setContent(`<div class="vditor" style="position:relative;width:950px;height:400px">
      <sup class="vditor-tooltipped vditor-tooltipped__s"
        style="position:absolute;left:775px;top:100px"
        aria-label="例：开两个终端，跑同一产品的两个实例。实例退出后，停止流程需要等两个进程各自退出，且不能影响其他使用者。">1</sup>
    </div>`);
    await page.addStyleTag({ path: path.join(ROOT, 'vditor/dist/index.css') });
    await page.hover('sup');
    const geometry = await page.evaluate(() => {
      const anchor = document.querySelector('sup');
      const rect = anchor.getBoundingClientRect();
      const after = getComputedStyle(anchor, '::after');
      const width = parseFloat(after.width);
      return { width, right: rect.left + rect.width / 2 + width / 2,
        maxWidth: parseFloat(after.maxWidth), viewport: innerWidth };
    });
    assert.ok(geometry.width <= geometry.maxWidth,
      `tooltip width ${geometry.width} exceeds max-width ${geometry.maxWidth}`);
    assert.ok(geometry.right <= geometry.viewport - 12,
      `tooltip right edge ${geometry.right} exceeds viewport ${geometry.viewport}`);
  });
