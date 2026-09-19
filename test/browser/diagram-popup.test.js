'use strict';

// jsdom 不跑 mermaid 的 SVG 渲染管线，弹窗克隆的底色固化也依赖真实计算样式，
// 因此在真实 Chromium 中驱动 vditor/dist 验证 diagram popup 的可读性契约。
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

const MERMAID_FLOWCHART = `flowchart TD
    A([用户提交分析请求]) --> B["1 确认任务<br/>提取材料、对象、窗口"]
    B -->|配置错误| C["2 校验并检查<br/>校验配置与数据能力"]
    C -->|发现事件| D["3 建立候选解释"]
    D --> E["4 补查与核对"]
`;

const MD = `# 连线可读性契约

\`\`\`mermaid
${MERMAID_FLOWCHART}
\`\`\`
`;

const parseColor = (value) => {
  const m = /rgba?\(([^)]+)\)/.exec(value || '');
  if (!m) return null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length < 3) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
};

const luminance = ({ r, g, b }) => {
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
};

const contrastRatio = (a, b) => {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const EDGE_SELECTOR = 'svg path.edge-path, svg .edgePaths path, svg g.edgePaths path, svg path.flowchart-link';

const readState = (page, scope) => page.evaluate(({ edgeSelector, scope: scopeName }) => {
  const root = document.querySelector('.vditor-mermaid-host');
  if (!root) return null;
  const container = scopeName === 'popup'
    ? document.querySelector('.vditor-diagram-overlay .vditor-diagram-overlay__content')
    : root.querySelector('.language-mermaid');
  const edge = (scopeName === 'popup'
    ? document.querySelector('.vditor-diagram-overlay')
    : root).querySelector(edgeSelector);
  return {
    containerBg: container ? getComputedStyle(container).backgroundColor : null,
    edgeStroke: edge ? getComputedStyle(edge).stroke : null,
  };
}, { edgeSelector: EDGE_SELECTOR, scope });

const assertReadable = (label, state) => {
  const edge = parseColor(state.edgeStroke);
  const bg = parseColor(state.containerBg);
  assert.ok(bg, `${label}容器背景应可解析：${state.containerBg}`);
  assert.ok(edge, `${label}连线 stroke 应可解析：${state.edgeStroke}`);
  assert.equal(edge.a, 1, `${label}连线应为不透明实色，实际 ${state.edgeStroke}`);
  const ratio = contrastRatio(edge, bg);
  assert.ok(ratio >= 3, `${label}连线与底色对比应 ≥3，实际 ${ratio.toFixed(2)}（${state.edgeStroke} on ${state.containerBg}）`);
};

test('diagram popup keeps container background and edge stroke readable',
  { skip: !browserPath && 'Set BROWSER_PATH to a Chromium executable' }, async t => {
    const { default: puppeteer } = await import('puppeteer-core');
    const server = http.createServer((req, res) => {
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
    const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
    t.after(() => browser.close().catch(() => {}));
    const base = `http://127.0.0.1:${server.address().port}`;

    const page = await browser.newPage();
    page.on('pageerror', error => console.error(error.message));
    await page.setViewport({ width: 1000, height: 900 });
    await page.setContent('<html><head></head><body style="margin:0"><div id="app"></div></body></html>');
    await page.addStyleTag({ url: base + '/vditor/dist/index.css' });
    await page.addStyleTag({ url: base + '/resource/markdown/index.css' });
    await page.addScriptTag({ url: base + '/vditor/dist/js/lute/lute.min.js', id: 'vditorLuteScript' });
    await page.addScriptTag({ url: base + '/vditor/dist/js/i18n/zh_CN.js' });
    await page.addScriptTag({ url: base + '/vditor/dist/index.min.js' });
    await page.evaluate(({ base, md }) => new Promise((resolve, reject) => {
      new Vditor('app', {
        value: md, mode: 'ir', i18n: VditorI18n, cdn: base + '/vditor',
        height: 860, cache: { enable: false }, toolbar: [],
        after: () => resolve(),
      });
      setTimeout(() => reject(new Error('vditor init timeout')), 20000);
    }), { base, md: MD });

    // Auto 主题（跟随编辑器浅色变量）下等 mermaid SVG 渲染完成
    await page.waitForSelector(`.vditor-mermaid-host ${EDGE_SELECTOR}`, { timeout: 30000 });

    // 契约 1：连线笔画必须是实色且与容器底色对比 ≥3（Auto 主题下 --second-color
    // 是 rgba(88,96,105,.36)，直通为 lineColor 时在浅底上不可读）
    const editorState = await readState(page, 'editor');
    assertReadable('编辑器内', editorState);

    // 打开弹窗
    await page.hover('.vditor-mermaid-host');
    await page.waitForSelector('.vditor-mermaid-chrome__popup-btn', { visible: true, timeout: 5000 });
    await page.click('.vditor-mermaid-chrome__popup-btn');
    await page.waitForSelector('.vditor-diagram-overlay--visible', { timeout: 5000 });
    await new Promise(r => setTimeout(r, 400));

    // 契约 2：弹窗克隆脱离编辑器变量作用域，且 .language-mermaid 与
    // .vditor-mermaid-host 同元素导致后代选择器背景规则失效——克隆必须
    // 固化编辑器内的实际容器底色，不得透明背衬毛玻璃遮罩
    const popupState = await readState(page, 'popup');
    assert.ok(popupState, '弹窗内应存在克隆内容');
    assert.notEqual(parseColor(popupState.containerBg)?.a, 0,
      `弹窗容器背景不得透明，实际 ${popupState.containerBg}`);
    assert.equal(popupState.containerBg, editorState.containerBg, '弹窗容器底色应与编辑器内一致');

    // 契约 3：弹窗内的连线（同一渲染结果）保持实色与达标对比
    assertReadable('弹窗内', popupState);
  });
