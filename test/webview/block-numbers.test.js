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
const { transformSync } = require('esbuild');

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
const SETTINGS_PANEL_PATH = path.join(ROOT, 'vditor', 'src', 'ts', 'ui', 'settingsPanel.ts');
const SETTINGS_TOOLBAR_PATH = path.join(ROOT, 'vditor', 'src', 'ts', 'toolbar', 'Settings.ts');
const VDITOR_TYPES_PATH = path.join(ROOT, 'vditor', 'src', 'types', 'index.d.ts');
const I18N_DIR = path.join(ROOT, 'vditor', 'src', 'js', 'i18n');

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
async function boot(content, mode = 'ir') {
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
    mode,
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
      && window.vditor.getCurrentMode && window.vditor.getCurrentMode() === mode
      && document.querySelector('.vditor-' + mode + ' .vditor-reset')) {
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
 * 无宿主的 standalone 回退契约：块首行文本在 getValue() 中的实际行号（独立于扫描器实现，
 * 按 includes 逐行查找）。契约 = data-lineno 与锚点行吻合，而非硬编码原文
 * 行号——vditor re-serialize 会规范化块间空行（本例：tight list 后空行 +1），
 * 此组验证未传 sourceText 的回退行为；宿主原文行号另有 source 组覆盖。
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

  it('S5: blockquote lazy continuation merges non-block lines (Lute parity)', () => {
    // Lute 实测 '> q1\n> q2\nplain' 渲染为单个 BLOCKQUOTE：非 > 前缀的
    // 非块起始行是懒延续，并入引用块
    assert.deepEqual(api.computeBlockStarts('> q1\n> q2\nplain\n'), [1]);
    // 懒延续 + 后续标题：引用吃到空行为止，标题独立成块（第 4 行）
    assert.deepEqual(api.computeBlockStarts('> q1\nplain\n\n# after\n'), [1, 4]);
    // 块起始形态行中断懒延续
    assert.deepEqual(api.computeBlockStarts('> q1\nplain\n# now heading\n'), [1, 3]);
  });

  it('S6: list swallows indented continuations after blank lines, breaks on a flush paragraph', () => {
    // lazy continuation：空行 + 缩进续行（空格或 Tab——编辑器 Tab 键即
    // 插入 \t）仍属列表块（段落从第 5 行起）
    assert.deepEqual(api.computeBlockStarts('- a\n\n  indented continues\n\nplain para\n'), [1, 5]);
    assert.deepEqual(api.computeBlockStarts('- a\n\n\tindented tab\n\nplain para\n'), [1, 5]);
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

  // 列表行后无空行紧跟的块起始形态：Lute 分块（实测 heading/quote/fence/hr
  // 各自成为独立顶层块），表格行并入列表内容
  it('S11: block starts right after a list line (no blank) break the list', () => {
    assert.deepEqual(api.computeBlockStarts('- a\n# H\n\ntext\n'), [1, 2, 4]);
    assert.deepEqual(api.computeBlockStarts('- a\n> q\n\ntext\n'), [1, 2, 4]);
    assert.deepEqual(api.computeBlockStarts('- a\n```\ncode\n```\n'), [1, 2]);
    assert.deepEqual(api.computeBlockStarts('- a\n---\n'), [1, 2]);
    // 表格行被 Lute 吸收进列表（实测顶层仅 ul 一个块）
    assert.deepEqual(api.computeBlockStarts('- a\n| x |\n|---|\n| y |\n'), [1]);
    // 缩进的块起始行是列表项内容（Lute 并入列表，不 break）——审查 R2
    // 抓到的回归：列表项内嵌围栏是常见形态
    assert.deepEqual(api.computeBlockStarts('- a\n  # H\n'), [1]);
    assert.deepEqual(api.computeBlockStarts('- a\n  ```\n  code\n  ```\n'), [1]);
  });

  // quote 懒延续在 $$ 块起始行中断（isBlockStart 与列表路径对称，
  // R2 抓到的回归）且段落同样在 $$ 块起始行断开（Lute 均分块）
  it('S12: $$ block starts break quotes, lists and paragraphs alike', () => {
    assert.deepEqual(api.computeBlockStarts('> q\n$$\nx\n$$\n'), [1, 2]);
    assert.deepEqual(api.computeBlockStarts('para\n$$\nx\n$$\n'), [1, 2]);
    assert.deepEqual(api.computeBlockStarts('- a\n$$\nx\n$$\n'), [1, 2]);
  });

  // $$ 数学块按 fence 处理（Lute 渲染为单个 math-block 顶层块）
  it('S13: $$ math blocks scan as one block, closed or same-line', () => {
    assert.deepEqual(api.computeBlockStarts('$$\n\na=1\n\nb=2\n$$\n\nafter\n'), [1, 8]);
    assert.deepEqual(api.computeBlockStarts('$$a=1$$\n\nafter\n'), [1, 3]);
  });

  it('S14: CRLF input scans like LF', () => {
    assert.deepEqual(api.computeBlockStarts('# H\r\n\r\npara1\r\n\r\npara2\r\n'), [1, 3, 5]);
  });

  it('S15: fenced blocks require the same marker and a sufficiently long closing fence', () => {
    assert.deepEqual(api.computeBlockStarts('~~~~js\na\n\n```\n~~~\nb\n~~~~\n\nafter\n'), [1, 9]);
    assert.deepEqual(api.computeBlockStarts('````\na\n\n```\nb\n````\n\nafter\n'), [1, 8]);
  });

  it('S16: empty list markers do not interrupt a paragraph', () => {
    assert.deepEqual(api.computeBlockStarts('before\n+\nafter\n'), [1]);
    assert.deepEqual(api.computeBlockStarts('before\n1.\nafter\n'), [1]);
  });
});

// 宿主原文与 Lute 导出文本的空行不同：第一张表前一行空行，第二张表前两行。
const MD_SOURCE = [
  '本阶段提供三个检查分支：', '',
  '| 检查分支 | 现象 | 判定要点 |', '| --- | --- | --- |',
  '| `delta_glitch` | 多次变化 | 至少两次 |',
  '| `high_too_short` | 高电平 | 宽度不足 |',
  '| `low_too_short` | 低电平 | 宽度不足 |', '',
  '#### 缺陷判定依据', '', '',
  '| A | B |', '| --- | --- |', '| x | y |', '', '后续段落',
].join('\n');

// 执行实际 index.js，替换工具栏等外围依赖；行号模块与编辑器使用真实实现。
async function bootWired(content, mode = 'ir') {
  const ctx = await boot(content, mode);
  const { window, document } = ctx;
  document.getElementById('app').id = 'vditor';
  window.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
  const listeners = {};
  const sent = [];
  const handler = {
    on(name, callback) { listeners[name] = callback; return handler; },
    emit(name, payload) { sent.push({ name, payload }); return handler; },
  };
  let options;
  let toolbarSave;
  let shortcutSave;
  window.handler = handler;
  window.ListMarkerLive = { install() {} };
  window.Vditor = function (_id, config) { options = config; return window.vditor; };
  const imageModule = { exports: {} };
  new window.Function('module', 'exports', transformSync(fs.readFileSync(path.join(ROOT, 'resource/markdown/imagePath.js'), 'utf8'), { format: 'cjs' }).code)(imageModule, imageModule.exports);
  window.require = name => {
    if (name === './imagePath.js') return imageModule.exports;
    if (name === './lang.js') return { mapVscodeLanguageToVditorLang: () => 'en_US' };
    if (name === './util.js') return {
      getToolbar: async (_root, save) => { toolbarSave = save; return []; },
      bindShortcut: (_handler, _editor, _base, save) => { shortcutSave = save; },
      createContextMenu() {}, setAIAvailable() {},
    };
    throw new Error('Unexpected import ' + name);
  };
  window.eval(transformSync(fs.readFileSync(INDEXJS_PATH, 'utf8'), { format: 'cjs' }).code);
  await listeners.open({ content, rootPath: '', workspaceBaseUrl: '', config: { editMode: mode } });
  options.after();
  return { ...ctx, listeners, sent, options, toolbarSave, shortcutSave,
    numbers: () => Array.from(document.querySelectorAll('.vditor-' + window.vditor.getCurrentMode() + ' .vditor-reset > [data-lineno]'))
      .map(el => Number(el.getAttribute('data-lineno'))),
  };
}

describe('block-numbers: host source wiring', { skip: !DIST_READY }, () => {
  it('open and external updates use host text, including a serialization-equal update', async () => {
    const ctx = await bootWired(MD_SOURCE);
    try {
      assert.deepEqual(ctx.numbers(), [1, 3, 9, 12, 16]);
      const external = '\n\n' + MD_SOURCE;
      ctx.listeners.update(external);
      ctx.window.BlockLineNumbers.sync();
      assert.deepEqual(ctx.numbers(), [3, 5, 11, 14, 18]);
      const serialized = ctx.window.vditor.getValue();
      ctx.listeners.update(serialized);
      assert.deepEqual(ctx.numbers(), [1, 4, 10, 13, 17]);
    } finally { ctx.window.close(); }
  });

  it('latest save acknowledgement supplies preserved text; older replies do not overwrite it', async () => {
    const ctx = await bootWired(MD_SOURCE);
    try {
      const first = MD_SOURCE.replace('本阶段', '第一阶段');
      ctx.window.vditor.setValue(first);
      const firstInput = ctx.window.vditor.getValue();
      ctx.options.input(firstInput);
      const second = MD_SOURCE.replace('本阶段', '第二阶段');
      ctx.window.vditor.setValue(second);
      const secondInput = ctx.window.vditor.getValue();
      ctx.options.input(secondInput);
      assert.deepEqual(ctx.numbers(), [], '待宿主同步时不显示旧文档行号');
      ctx.listeners.lineNumberSource({ input: firstInput, content: '\n' + first });
      assert.deepEqual(ctx.numbers(), []);
      ctx.listeners.lineNumberSource({ input: secondInput, content: second });
      assert.deepEqual(ctx.numbers(), [1, 3, 9, 12, 16]);
      ctx.listeners.lineNumberSource({ input: firstInput, content: '\n' + first });
      assert.deepEqual(ctx.numbers(), [1, 3, 9, 12, 16]);
      // 模式切换仅影响导出格式，不改变宿主原文行号。
      ctx.window.vditor.switchEditMode('wysiwyg');
      ctx.window.BlockLineNumbers.sync();
      assert.deepEqual(ctx.numbers(), [1, 3, 9, 12, 16]);
    } finally { ctx.window.close(); }
  });

  for (const method of ['toolbarSave', 'shortcutSave']) {
    it(method + ' tracks manual-save replies without reloading the editor', async () => {
      const ctx = await bootWired(MD_SOURCE);
      try {
        ctx[method]();
        const input = ctx.sent.findLast(item => item.name === 'doSave').payload;
        ctx.listeners.lineNumberSource({ input, content: MD_SOURCE });
        assert.deepEqual(ctx.numbers(), [1, 3, 9, 12, 16]);
      } finally { ctx.window.close(); }
    });
  }
});

describe('block-numbers: host source lines', { skip: !DIST_READY }, () => {
  for (const mode of ['ir', 'wysiwyg']) {
    for (const fixture of [
      { name: 'tilde fences', source: '~~~js\na\n\nb\n~~~\n\nafter\n', lines: [1, 7] },
      { name: 'tab-separated headings', source: 'before\n#\tTitle\n\nafter\n', lines: [1, 2, 4] },
      { name: 'tab-separated lists', source: 'before\n-\titem\n\nafter\n', lines: [1, 2, 4] },
      { name: 'spaced thematic breaks', source: 'before\n* * *\nafter\n', lines: [1, 2, 3] },
    ]) {
      it(mode + ': raw ' + fixture.name + ' retain source mapping', async () => {
        const { window, document } = await boot(fixture.source, mode);
        try {
          window.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
          window.BlockLineNumbers.install(window.vditor, { sourceText: fixture.source });
          assert.deepEqual(Array.from(document.querySelectorAll('[data-lineno]'))
            .map(el => Number(el.getAttribute('data-lineno'))), fixture.lines);
        } finally { window.close(); }
      });
    }
    it(mode + ': setext headings retain source lines without normalization', async () => {
      const source = 'Title\n---\n\nparagraph\n';
      const { window, document } = await boot(source, mode);
      try {
        window.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
        window.BlockLineNumbers.install(window.vditor, { sourceText: source });
        const numbers = Array.from(document.querySelectorAll('[data-lineno]'))
          .map(el => Number(el.getAttribute('data-lineno')));
        assert.deepEqual(numbers, [1, 4]);
      } finally { window.close(); }
    });
    it(mode + ': table serialization does not shift source line numbers', async () => {
      const { window, document } = await boot(MD_SOURCE, mode);
      try {
        window.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
        window.BlockLineNumbers.install(window.vditor, { sourceText: MD_SOURCE });
        const root = document.querySelector('.vditor-' + mode + ' .vditor-reset');
        const numbers = () => Array.from(root.querySelectorAll(':scope > [data-lineno]'))
          .map(el => Number(el.getAttribute('data-lineno')));
        assert.deepEqual(numbers(), [1, 3, 9, 12, 16]);
        // 重渲染与开关不应退回 Lute 规范化后的行号。
        window.BlockLineNumbers.sync();
        window.BlockLineNumbers.setEnabled(false);
        window.BlockLineNumbers.setEnabled(true);
        assert.deepEqual(numbers(), [1, 3, 9, 12, 16]);
        assert.ok(!window.vditor.getValue().includes('data-lineno'));
      } finally {
        window.close();
      }
    });
  }
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

  it('N4: getValue() output never contains data-lineno or --lineno (Lute fence)', () => {
    const value = ctx.window.vditor.getValue();
    assert.ok(typeof value === 'string');
    assert.ok(!value.includes('data-lineno'), JSON.stringify(value.slice(0, 200)));
    assert.ok(!value.includes('--lineno'), JSON.stringify(value.slice(0, 200)));
  });

  it('N5: disabled install injects nothing; setEnabled re-installs with a live observer', async () => {
    const b2 = await boot(MD_N);
    try {
      b2.window.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      b2.window.BlockLineNumbers.install(b2.window.vditor, { enabled: false });
      await sleep(120);
      assert.equal(linenosOf(b2.document).length, 0, 'disabled install still injected');
      b2.window.BlockLineNumbers.setEnabled(true);
      await sleep(120);
      assert.deepEqual(linenosOf(b2.document), anchorStarts(b2.window.vditor.getValue()));
      // observer 重建检测：不手动 sync，直接改 DOM，rAF 后必须自动重编号
      // （setEnabled 内部的同步 sync() 掩盖不了 observer 缺失——之前缺失时此步会漏更新）
      const blocks = b2.document.querySelectorAll('.vditor-reset > [data-lineno]');
      const victim = blocks[blocks.length - 1];
      victim.remove();
      await sleep(200);
      const after = linenosOf(b2.document);
      assert.equal(after.length, blocks.length - 1, 'observer did not re-number after DOM change');
    } finally {
      b2.window.close();
    }
  });

  it('N6: scanner/Lute divergence degrades to no numbers, never wrong ones', async () => {
    // 混合标记列表（'- a' 连 '* b'）：Lute 拆两个 ul（DOM 3 块），扫描器
    // 并为一块（2 起点）——数量防护必须全部不编号而不是按序错配
    const b3 = await boot('- alpha\n* beta\n\nplain para\n');
    try {
      b3.window.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      b3.window.BlockLineNumbers.install(b3.window.vditor);
      await sleep(120);
      const resetChildren = b3.document.querySelectorAll('.vditor-reset > ul, .vditor-reset > p').length;
      assert.ok(resetChildren >= 3, `precondition: Lute split the lists (got ${resetChildren})`);
      assert.equal(linenosOf(b3.document).length, 0, 'divergent document must show no numbers');
    } finally {
      b3.window.close();
    }
  });
});

// ── D：扫描器块数与 Lute 顶层块数对照 ───────────────────────────────────

// 数量一致是行号 1:1 映射的前提（数量不等时模块全部不编号）。此组把
// "扫描器块序列 = Lute 渲染块序列"钉进契约——S 组纯函数自洽测不出的
// 语义分叉（审查发现的四类形态正是这样漏网的）在此被真实引擎拦截
describe('block-numbers: scanner parity with real Lute (D)', { skip: DIST_READY ? false : '依赖 vditor/dist 构建产物' }, () => {
  let api;
  let lute;
  let parse;
  before(() => {
    api = loadModuleApi();
  });

  before(() => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously', pretendToBeVisual: true });
    dom.window.eval(fs.readFileSync(path.join(DIST, 'js', 'lute', 'lute.min.js'), 'utf8'));
    const Lute = dom.window.Lute;
    Lute.PutEmphasisText = false;
    lute = Lute.New();
    parse = (html) => new dom.window.DOMParser().parseFromString(html, 'text/html');
  });

  const PARITY_CASES = [
    ['plain', '# H\n\ntext\n'],
    ['list+heading-nows', '- a\n# H\n\ntext\n'],
    ['list+quote-nows', '- a\n> q\n\ntext\n'],
    ['list+table-nows', '- a\n| x |\n|---|\n| y |\n'],
    ['list+fence-nows', '- a\n```\ncode\n```\n'],
    ['list+hr-nows', '- a\n---\n'],
    ['list+indented-heading', '- a\n  # H\n'],
    ['list+indented-fence', '- a\n  ```\n  code\n  ```\n'],
    ['quote-lazy', '> q1\n> q2\nplain\n'],
    ['quote-lazy-then-heading', '> q1\nplain\n\n# after\n'],
    ['quote+math', '> q\n$$\nx\n$$\n'],
    ['para+math', 'para\n$$\nx\n$$\n'],
    ['list+math', '- a\n$$\nx\n$$\n'],
    ['tab-cont', '- a\n\n\tindented\n\nplain\n'],
    ['math-multiline', '$$\n\na=1\n\nb=2\n$$\n\nafter\n'],
    ['math-inline-block', '$$a=1$$\n\nafter\n'],
    ['mixed-kinds-lists', '- a\n- b\n\n1. one\n2. two\n'],
    ['same-kind-loose', '- a\n\n- b\n'],
  ];

  for (const [name, md] of PARITY_CASES) {
    it(`D: ${name} — scanner block count equals Lute top-level count`, () => {
      const html = lute.Md2VditorIRDOM(md);
      const tops = Array.from(parse(html).body.children)
        .map(el => el.tagName.toLowerCase() + (el.getAttribute('data-type') ? `[${el.getAttribute('data-type')}]` : ''));
      const luteCount = tops.length;
      const starts = api.computeBlockStarts(md);
      assert.equal(
        starts.length, luteCount,
        JSON.stringify({ tops, starts }),
      );
    });
  }
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

  it('C7: faint vertical rule separates the number column from badges', () => {
    // 竖线画为 reset 的背景渐变 + background-attachment:local——绝对定位
    // ::before 的 top/bottom:0 只解析到一屏高的 padding box，滚动后线消失；
    // local 背景随滚动内容平铺整个滚动区，线贯穿全文档
    assert.match(css, /vmd-block-linenumbers[^{]*vditor-reset[^{]*\{[^}]*background-image:\s*linear-gradient\(90deg/);
    assert.match(css, /rgba\(128,\s*128,\s*128,\s*0\.5\)\s*35px/);
    assert.match(css, /vmd-block-linenumbers[^{]*vditor-reset[^{]*\{[^}]*background-attachment:\s*local/);
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

  it('H3: badge top is fixed at 0 (no JS-synced CSS variable)', () => {
    const less = fs.readFileSync(IR_LESS_PATH, 'utf8');
    // mixin 已固定 top: 0（原 var(--vditor-block-marker-top) 随死代码清理移除）
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

  it('W5: panel toggle round-trips through the VS Code setting (editMode-style)', () => {
    // 单一数据源：面板开关不落 localStorage，经回调 → 扩展侧写配置 →
    // onDidChangeConfiguration 广播 → 各面板 markdownConfig 生效
    const js = fs.readFileSync(INDEXJS_PATH, 'utf8');
    assert.match(js, /blockLineNumbers:\s*markdownBlockLineNumbers\s*!==\s*false/);
    assert.match(js, /onChangeBlockLineNumbers/);
    assert.match(js, /emit\('blockLineNumbers'/);
    const provider = fs.readFileSync(PROVIDER_PATH, 'utf8');
    assert.match(provider, /on\(['"]blockLineNumbers['"]/);
    // workspace 覆盖存在时须写回 workspace 作用域，否则开关静默失效
    assert.match(provider, /update\(['"]markdownBlockLineNumbers['"],\s*newValue,\s*target\)/);
    assert.match(provider, /ConfigurationTarget\.Workspace/);
  });
});

// ── P：编辑器内设置面板开关（vditor Settings modal） ────────────────────

describe('block-numbers: in-editor settings panel (P)', () => {
  it('P1: panel renders a Block Line Numbers toggle initialized from options', () => {
    const src = fs.readFileSync(SETTINGS_PANEL_PATH, 'utf8');
    // 初值来自 Vditor options（VS Code 配置透传），不是 localStorage
    assert.match(src, /blockLineNumbers/);
    assert.match(src, /buildToggleHTML\(BLOCK_LINE_NUMBERS_KEY,\s*i18n\.blockLineNumbers\s*\?\?\s*"Block Line Numbers"/);
    assert.match(src, /options\.blockLineNumbers\s*!==\s*false/);
  });

  it('P2: toolbar Settings routes the toggle to the onChange callback, bypassing localStorage', () => {
    const src = fs.readFileSync(SETTINGS_TOOLBAR_PATH, 'utf8');
    // 行号 key 在通用 localStorage 写入之前拦截（不进 vditor-global-settings）
    assert.match(src, /BLOCK_LINE_NUMBERS_KEY/);
    assert.match(src, /onChangeBlockLineNumbers\?\.\(next\)/);
    const toggleBlock = src.match(/\/\/ Toggle switch[\s\S]*?\/\/ Dropdown trigger/);
    assert.ok(toggleBlock, 'toggle branch not found');
    const intercept = toggleBlock[0].indexOf('BLOCK_LINE_NUMBERS_KEY');
    const genericWrite = toggleBlock[0].indexOf('setGlobalLocalStorageSetting(key');
    assert.ok(intercept >= 0, 'block line numbers intercept missing in toggle branch');
    assert.ok(genericWrite > intercept, 'intercept must precede the generic localStorage write');
  });

  it('P3: IOptions declares the value and the change callback', () => {
    const src = fs.readFileSync(VDITOR_TYPES_PATH, 'utf8');
    assert.match(src, /blockLineNumbers\?:\s*boolean/);
    assert.match(src, /onChangeBlockLineNumbers\?\(enabled:\s*boolean\):\s*void/);
  });

  it('P4: i18n ships the blockLineNumbers label in every locale', () => {
    const locales = fs.readdirSync(I18N_DIR).filter((f) => f.endsWith('.js'));
    assert.ok(locales.length >= 6, `unexpected locale count: ${locales.length}`);
    for (const f of locales) {
      const src = fs.readFileSync(path.join(I18N_DIR, f), 'utf8');
      assert.match(src, /'blockLineNumbers':\s*'[^']*'/, `${f} missing blockLineNumbers`);
    }
  });
});
