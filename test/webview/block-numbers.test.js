'use strict';

/**
 * Webview 集成测试 — 段落源码行号 + Hx 徽标常驻（resource/markdown/block-numbers.js）
 *
 * 功能 A：每个独立段落（块级元素）首行左侧显示其源码起始行号。
 * 移植自 hardened 仓库 src/extension.ts lineNumberScript 的块扫描器
 * （d64e408，源自上游 PR #157 by asalcedo29），按 fork 适配：
 * - 显示层走 data-lineno 属性 + CSS ::before/attr()（挂在块上随滚动移动），
 *   而非固定行号槽（#ln-gutter）+ rect 计算
 * - 可见块判定不用 offsetHeight（jsdom 无布局恒为 0；真实浏览器也只是启发式），
 *   改用块级标签白名单，天然排除首尾哨兵 span.vditor-editor-boundary
 *   （fork 的边界保障是裸 span，不是空 p，见 renderDomByMd.ts）
 * - 空 p（编辑产物，如文档首行 Enter）不编号不占号：空行不属于任何段落
 *
 * 功能 B：Hx 徽标常驻 —— h1-h6 的 :before 徽标从 .vditor-heading--active
 * 限定放宽为常驻显示；active 保留为光标行高亮变体；默认开，
 * markdownHeadingBadges=false 时覆盖层压制回退现状。
 *
 * 分组：
 * - S：computeBlockStarts 纯函数契约（轻 jsdom，不依赖构建产物）
 * - N：install 后 data-lineno 注入 / 更新 / 栅栏（IR 模式真实构建产物）
 * - C：行号 CSS 契约（resource/markdown/index.css）
 * - H：徽标常驻 CSS 契约（vditor less 源 + 覆盖层回退态）
 * - W：接线契约（index.html/js、package.json、provider）
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { TextDecoder, TextEncoder } = require('node:util');
const { webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'vditor', 'dist');
const MODULE_PATH = path.join(ROOT, 'resource', 'markdown', 'block-numbers.js');
const CSS_PATH = path.join(ROOT, 'resource', 'markdown', 'index.css');
const HTML_PATH = path.join(ROOT, 'resource', 'markdown', 'index.html');
const INDEXJS_PATH = path.join(ROOT, 'resource', 'markdown', 'index.js');
const PKG_PATH = path.join(ROOT, 'package.json');
const IR_LESS_PATH = path.join(ROOT, 'vditor', 'src', 'assets', 'less', '_ir.less');
const WYSIWYG_LESS_PATH = path.join(ROOT, 'vditor', 'src', 'assets', 'less', '_wysiwyg.less');
const PROVIDER_PATH = path.join(ROOT, 'src', 'provider', 'markdownEditorProvider.ts');

const MODULE_READY = fs.existsSync(MODULE_PATH);
const DIST_READY = fs.existsSync(path.join(DIST, 'index.min.js'))
  && fs.existsSync(path.join(DIST, 'js', 'lute', 'lute.min.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fileUrl = (p) => 'file://' + p.replace(/\\/g, '/');

/** 轻量 jsdom：只 eval 模块源码拿纯函数（模块顶层不得触碰 DOM） */
function loadModuleApi() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
  dom.window.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
  return dom.window.BlockLineNumbers;
}

/**
 * 以真实构建产物启动 IR 编辑器（骨架同 list-marker.test.js）。
 * 测试文档避开 fence/frontmatter（jsdom 无布局，CM 懒挂载不可控），
 * 这两类形态由 S 组纯函数覆盖。
 */
async function boot(content) {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => pageErrors.push(String(err)));

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: fileUrl(path.join(ROOT, '__block-numbers-test__.html')),
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const { document } = window;

  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  window.crypto = webcrypto;
  if (typeof window.fetch === 'undefined') {
    window.fetch = () => Promise.reject(new Error('fetch stub'));
  }
  if (typeof document.execCommand !== 'function') {
    document.execCommand = function () { return true; };
  }
  if (!('innerText' in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent; },
      set(v) { this.textContent = v; },
    });
  }
  window.HTMLElement.prototype.scrollIntoView = function () { };
  window.IntersectionObserver = class {
    constructor() { }
    observe() { }
    unobserve() { }
    disconnect() { }
    takeRecords() { return []; }
  };
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q, onchange: null,
    addListener() { }, removeListener() { },
    addEventListener() { }, removeEventListener() { },
    dispatchEvent() { return false; },
  }));

  window.eval(fs.readFileSync(path.join(DIST, 'js', 'lute', 'lute.min.js'), 'utf8'));
  const stubScript = (id) => {
    const s = document.createElement('script');
    s.id = id;
    document.head.appendChild(s);
  };
  stubScript('vditorLuteScript');

  window.eval(fs.readFileSync(path.join(DIST, 'js', 'i18n', 'en_US.js'), 'utf8'));
  const i18n = window.VditorI18n;

  window.eval(fs.readFileSync(path.join(DIST, 'index.min.js'), 'utf8'));
  if (typeof window.Vditor === 'undefined') {
    throw new Error('Vditor did not load');
  }

  let booted = false;
  window.vditor = new window.Vditor('app', {
    value: content,
    mode: 'ir',
    lang: 'en_US',
    i18n,
    cdn: fileUrl(path.join(ROOT, 'vditor')),
    height: '600px',
    cache: { enable: false },
    toolbar: [],
    after() { booted = true; },
  });

  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (booted
      && window.vditor.getCurrentMode && window.vditor.getCurrentMode() === 'ir'
      && document.querySelector('.vditor-ir .vditor-reset')) {
      return { window, document };
    }
  }
  throw new Error('editor did not boot; page errors: ' + pageErrors.join(' | ').slice(0, 2000));
}

/** reset 直接子元素中带 data-lineno 的块，按序返回行号数组 */
const linenosOf = (document) =>
  Array.from(document.querySelectorAll('.vditor-ir .vditor-reset > [data-lineno]'))
    .map((el) => parseInt(el.getAttribute('data-lineno'), 10));

// S 组文档：frontmatter + 七类块形态（fence 用 ``` 围栏）
const MD_S = [
  '---',
  'title: t',
  '---',
  '',
  '# H1 title',
  '',
  'First paragraph line1',
  'line2',
  '',
  '- alpha',
  '- beta',
  '',
  'between lists',
  '',
  '1. one',
  '2. two',
  '',
  '```js',
  'code',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '> quote line1',
  '> quote line2',
  '',
  'Last paragraph.',
  '',
].join('\n');

// N 组文档：无 frontmatter / fence（避开 jsdom CM 挂载），六类块形态
const MD_N = [
  '# H1 title',
  '',
  'First paragraph line1',
  'line2',
  '',
  '- alpha',
  '- beta',
  '',
  'between lists',
  '',
  '1. one',
  '2. two',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '> quote line1',
  '> quote line2',
  '',
  'Last paragraph.',
  '',
].join('\n');

/**
 * 期望行号锚点法：块首行文本在 getValue() 中的实际行号（独立于扫描器实现，
 * 按 includes 逐行查找）。契约 = data-lineno 与锚点行吻合，而非硬编码原文
 * 行号——vditor re-serialize 会规范化块间空行（本例：tight list 后空行 +1），
 * 行号语义自洽于"当前编辑文本"，硬编码原文行号是错误断言。
 */
const MD_N_ANCHORS = [
  '# H1 title',
  'First paragraph line1',
  '- alpha',
  'between lists',
  '1. one',
  '| a | b |',
  '> quote line1',
  'Last paragraph.',
];

function anchorStarts(value) {
  const lines = value.split('\n');
  return MD_N_ANCHORS.map((needle) => {
    const idx = lines.findIndex((l) => l.includes(needle));
    assert.ok(idx >= 0, `anchor not in getValue(): ${needle}`);
    return idx + 1;
  });
}

// ── S：computeBlockStarts 纯函数契约 ────────────────────────────────────

describe('block-numbers: block scanner contract (S)', { skip: MODULE_READY ? false : 'block-numbers.js 未创建' }, () => {
  let api;
  before(() => {
    api = loadModuleApi();
  });

  it('S1: seven block shapes each report their 1-based start line', () => {
    assert.deepEqual(api.computeBlockStarts(MD_S),
      [1, 5, 7, 10, 13, 15, 18, 22, 26, 29]);
  });

  it('S2: empty document yields no blocks', () => {
    assert.deepEqual(api.computeBlockStarts(''), []);
    assert.deepEqual(api.computeBlockStarts('\n\n\n'), []);
  });

  it('S3: paragraph breaks on the next block-shaped line', () => {
    // 段落内第二行是标题 → 各自成块
    assert.deepEqual(api.computeBlockStarts('one two\n# now heading\n'), [1, 2]);
    // 段落内第二行是普通文本 → 聚为一块
    assert.deepEqual(api.computeBlockStarts('one\ntwo\n'), [1]);
  });

  it('S4: unterminated fence consumes to end of file', () => {
    assert.deepEqual(api.computeBlockStarts('```\nnever closed\nstill code\n'), [1]);
  });

  it('S5: blockquote stops at the first non-> line', () => {
    assert.deepEqual(api.computeBlockStarts('> q1\n> q2\nplain\n'), [1, 3]);
  });

  it('S6: list swallows indented continuations after blank lines, breaks on a flush paragraph', () => {
    // lazy continuation：空行 + 缩进续行仍属列表块（段落从第 5 行起）
    assert.deepEqual(api.computeBlockStarts('- a\n\n  indented continues\n\nplain para\n'), [1, 5]);
  });

  it('S7: leading --- without a closing fence is a plain hr, not frontmatter', () => {
    // 与 hardened 源的有意分歧（divergence）：无闭合 --- 时 frontmatter 分支会把
    // 整个文档吞成一块。这里要求回退普通解析（L1 为 hr 单行块）
    assert.deepEqual(api.computeBlockStarts('---\n\n# H\n'), [1, 3]);
  });

  it('S8: html block lines (div/p raw) scan as ordinary paragraph lines', () => {
    // 扫描器不识别 html 块语法：按段落规则聚块（记录现状，与 hardened 一致）
    assert.deepEqual(api.computeBlockStarts('<div>\ntext\n</div>\n\npara\n'), [1, 5]);
  });

  // 空行隔开的异类型相邻列表（ul 后跟 ol）在 DOM 是两个块（Lute 分开渲染），
  // 扫描器必须同样分块——否则后续所有块的行号系统性错位一位
  // （探针页视觉验收抓到的缺陷；hardened 源同样存在）
  it('S9: blank-line-separated lists of different kinds split into two blocks', () => {
    assert.deepEqual(api.computeBlockStarts('- a\n- b\n\n1. one\n2. two\n'), [1, 4]);
    assert.deepEqual(api.computeBlockStarts('1. one\n\n- a\n'), [1, 3]);
  });

  // 同类型列表空行分隔 = CommonMark loose list，Lute 渲染为单个列表 → 仍是一块
  it('S10: blank-line-separated same-kind list stays one loose block', () => {
    assert.deepEqual(api.computeBlockStarts('- a\n\n- b\n'), [1]);
    assert.deepEqual(api.computeBlockStarts('1. one\n\n2. two\n'), [1]);
  });
});

// ── N：模块行为契约（IR 模式，真实构建产物） ────────────────────────────

describe('block-numbers: module contract on IR editor (N)', { skip: DIST_READY && MODULE_READY ? false : '依赖 vditor/dist 构建产物与 block-numbers.js' }, () => {
  let ctx;
  before(async () => {
    ctx = await boot(MD_N);
    ctx.window.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
    ctx.window.BlockLineNumbers.install(ctx.window.vditor);
    await sleep(120); // install 首扫 + observer 兜底
  });

  it('N1: every content block carries its source start line', () => {
    const { window, document } = ctx;
    const reset = document.querySelector('.vditor-ir .vditor-reset');
    assert.ok(reset, 'no IR reset');
    const expected = anchorStarts(window.vditor.getValue());
    assert.deepEqual(linenosOf(document), expected, JSON.stringify({
      kids: Array.from(reset.children).map((c) => c.tagName + '.' + c.className),
      got: linenosOf(document),
      expected,
    }));
  });

  it('N2: boundary sentinels and empty paragraphs never take a number', () => {
    const { window, document } = ctx;
    const reset = document.querySelector('.vditor-ir .vditor-reset');
    // 哨兵 span（fork 的边界保障）与空 p（编辑产物）混进首部；
    // getValue() 从 DOM 序列化，空 p 会让源文本多出空行——后续块行号
    // 随"当前编辑文本"如实偏移（正确语义），但空 p/哨兵自身不得占号
    reset.insertAdjacentHTML('afterbegin', '<span class="vditor-editor-boundary" data-block="0" contenteditable="true" aria-hidden="true">\u200b</span>');
    reset.insertAdjacentHTML('afterbegin', '<p data-block="0"><br></p>');
    window.BlockLineNumbers.sync();
    const emptyP = reset.firstElementChild;
    assert.equal(emptyP.tagName, 'P', 'precondition: first child is the injected empty p');
    assert.ok(!emptyP.hasAttribute('data-lineno'), 'empty paragraph took a line number');
    const sentinel = reset.querySelector('span.vditor-editor-boundary');
    assert.ok(sentinel, 'precondition: sentinel present');
    assert.ok(!sentinel.hasAttribute('data-lineno'), 'boundary sentinel took a line number');
    assert.deepEqual(linenosOf(document), anchorStarts(window.vditor.getValue()));
  });

  it('N3: full reload (setValue) re-numbers the new document', async () => {
    const { window, document } = ctx;
    window.vditor.setValue('# New head\n\nLast paragraph.\n');
    await sleep(400); // setValue 全量重绘 + observer rAF
    const lines = window.vditor.getValue().split('\n');
    const head = lines.findIndex((l) => l.includes('# New head')) + 1;
    const last = lines.findIndex((l) => l.includes('Last paragraph.')) + 1;
    assert.ok(head > 0 && last > head, JSON.stringify(lines));
    assert.deepEqual(linenosOf(document), [head, last]);
  });

  it('N4: getValue() output never contains data-lineno (Lute fence)', () => {
    const value = ctx.window.vditor.getValue();
    assert.ok(typeof value === 'string');
    assert.ok(!value.includes('data-lineno'), JSON.stringify(value.slice(0, 200)));
  });

  it('N5: disabled install injects nothing; setEnabled re-installs', async () => {
    const b2 = await boot(MD_N);
    try {
      b2.window.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      b2.window.BlockLineNumbers.install(b2.window.vditor, { enabled: false });
      await sleep(120);
      assert.equal(linenosOf(b2.document).length, 0, 'disabled install still injected');
      b2.window.BlockLineNumbers.setEnabled(true);
      await sleep(120);
      assert.deepEqual(linenosOf(b2.document), anchorStarts(b2.window.vditor.getValue()));
    } finally {
      b2.window.close();
    }
  });
});

// ── C：行号 CSS 契约 ────────────────────────────────────────────────────

describe('block-numbers: CSS contract (C)', () => {
  let css;
  before(() => {
    css = fs.readFileSync(CSS_PATH, 'utf8');
  });

  it('C1: enabled gutter renders line number via attr(data-lineno) on ::after', () => {
    // ::after 而非 ::before：before 被 Hx 徽标 / 块类型徽标占用，
    // 且 table 的 before 会被表格布局吞掉
    assert.match(css, /\[data-lineno\][^{]*::?after[^{]*\{[^}]*content:\s*attr\(data-lineno\)/);
  });

  it('C2: line-number column reserves editor padding (gutter space)', () => {
    assert.match(css, /vmd-block-linenumbers[^{]*\.vditor-reset[^{]*\{[^}]*padding-left/);
  });

  it('C3: numbered blocks get a positioning anchor for the ::before', () => {
    assert.match(css, /\[data-lineno\][^{]*\{[^}]*position:\s*relative/);
  });

  it('C4: disabled state suppresses the gutter', () => {
    assert.match(css, /vmd-linenumbers-off[^{]*::?after[^{]*\{[^}]*content:\s*none/);
  });

  it('C5: table number anchors on the first header cell via --lineno', () => {
    // table 自身伪元素被匿名表格盒修复吞掉（computed 正确但不渲染），
    // 行号锚到 th:first-child::after，值经继承的 --lineno 传递
    assert.match(css, /table\[data-lineno\] th:first-child::?after[^{]*\{[^}]*content:\s*var\(--lineno\)/);
    assert.match(css, /table\[data-lineno\]::?after[^{]*\{[^}]*content:\s*none/);
    // 引擎给 table 的 overflow:auto 会裁掉盒外的行号；开行号时改为
    // visible，宽表格横向滚动由编辑面（overflow:auto 的 reset）兜底
    assert.match(css, /table\[data-lineno\][^{]*\{[^}]*overflow:\s*visible/);
  });

  it('C6: blockquote number compensates the left-border anchor shift', () => {
    assert.match(css, /blockquote\[data-lineno\]::?after[^{]*\{[^}]*left:\s*-6[0-9]px/);
  });
});

// ── H：Hx 徽标常驻 CSS 契约 ─────────────────────────────────────────────

describe('block-numbers: heading badge always-on CSS contract (H)', () => {
  it('H1: _ir.less shows H1 badge without the active-class gate', () => {
    const less = fs.readFileSync(IR_LESS_PATH, 'utf8');
    // `> h1:before`（h1 紧跟 :before，不带 .vditor-heading--active 修饰）
    // 即常驻规则；active 版选择器是 h1.vditor-heading--active:before
    const m = less.match(/>\s*h1:before[\s\S]{0,400}?content:\s*'H1'/);
    assert.ok(m, 'always-on h1 badge rule missing in _ir.less');
  });

  it('H2: _wysiwyg.less shows H1 badge without the active-class gate', () => {
    const less = fs.readFileSync(WYSIWYG_LESS_PATH, 'utf8');
    const m = less.match(/>\s*h1:before[\s\S]{0,400}?content:\s*'H1'/);
    assert.ok(m, 'always-on h1 badge rule missing in _wysiwyg.less');
  });

  it('H3: badge top no longer depends on the JS-synced CSS variable', () => {
    const less = fs.readFileSync(IR_LESS_PATH, 'utf8');
    // 徽标规则内固定 top（后声明覆盖 mixin 的 var(--vditor-block-marker-top)）
    assert.match(less, /h[1-6]:before[\s\S]{0,600}?top:\s*0/);
  });

  it('H4: overlay provides the opt-out (suppress non-active badges)', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    assert.match(css, /vmd-heading-badges-off[^{]*h[1-6](?::not\(\.vditor-heading--active\))?::?before[^{]*\{[^}]*content:\s*none/);
  });
});

// ── W：接线契约 ─────────────────────────────────────────────────────────

describe('block-numbers: wiring contract (W)', () => {
  it('W1: index.html loads block-numbers.js before index.js', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const bn = html.indexOf('block-numbers.js');
    assert.ok(bn > 0, 'block-numbers.js script tag missing');
    assert.ok(html.indexOf('index.js') > bn, 'block-numbers.js must load before index.js');
  });

  it('W2: index.js installs the module in after()', () => {
    const js = fs.readFileSync(INDEXJS_PATH, 'utf8');
    assert.match(js, /BlockLineNumbers\.install\(editor/);
  });

  it('W3: package.json declares both settings (defaults on)', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    // configuration 是分组数组（Git History / Markdown / …），跨分组合并查找
    const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties || {}));
    assert.equal(props['vscode-office.markdownBlockLineNumbers']?.default, true);
    assert.equal(props['vscode-office.markdownHeadingBadges']?.default, true);
  });

  it('W4: provider passes both settings and syncs them live', () => {
    const src = fs.readFileSync(PROVIDER_PATH, 'utf8');
    assert.match(src, /markdownBlockLineNumbers/);
    assert.match(src, /markdownHeadingBadges/);
    // 动态同步 key 表须包含两个新键
    const block = src.match(/MARKDOWN_SYNC_CONFIG_KEYS[^;]*\[[\s\S]*?\]/);
    assert.ok(block, 'MARKDOWN_SYNC_CONFIG_KEYS array not found');
    assert.match(block[0], /markdownBlockLineNumbers/);
    assert.match(block[0], /markdownHeadingBadges/);
  });
});
