'use strict';

/**
 * Webview 集成测试 — 列表 marker 聚焦可编辑（resource/markdown/list-marker.js）
 *
 * 移植自 hardened 仓库 tests/integration/list-marker.js（25 项契约），按 fork 适配：
 * - 加载 fork 的真实构建产物（vditor/dist/index.min.js + lute）
 * - 模块经 window.eval 注入页面上下文（模块内部直接使用 document/window）
 * - 事件必须派发到 wysiwyg.element（.vditor-wysiwyg .vditor-reset），
 *   它是 .vditor-wysiwyg 容器的子元素，派发到父容器事件到不了监听器
 * - jsdom 需补 innerText polyfill（fork 的 wysiwyg input 管线
 *   调 blockElement.innerText.startsWith）
 *
 * 分组：
 * - R/L：Lute 引擎语义栅栏（对无模块的现状即应通过——fork issue #1 的前置验证）
 * - G：monkey-patch 闸门黑盒（span 绝不泄漏进 markdown）
 * - E：聚焦激活 / 重编号 / 升格段落
 * - U：undo 快照干净度（fork undo 栈存 innerHTML，恢复绕过闸门，
 *   依赖 selectionchange 清扫 + 保存路径闸门兜底）
 * - C：CSS 契约（resource/markdown/index.css）
 *
 * 前置：需先构建 vditor 子包（vditor/dist 不入库）。未构建时整组跳过。
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { TextDecoder, TextEncoder } = require('node:util');
const { webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'vditor', 'dist');
const MODULE_PATH = path.join(ROOT, 'resource', 'markdown', 'list-marker.js');
const CSS_PATH = path.join(ROOT, 'resource', 'markdown', 'index.css');

const MD = '1. first\n2. second\n\n- alpha\n- beta\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIST_READY = fs.existsSync(path.join(DIST, 'index.min.js'))
  && fs.existsSync(path.join(DIST, 'js', 'lute', 'lute.min.js'));

const fileUrl = (p) => 'file://' + p.replace(/\\/g, '/');

/**
 * 以真实构建产物启动编辑器。返回 { window, document }。
 * 所有外部依赖（lute、i18n）预 eval 并以选项/桩短路加载器。
 */
async function boot(content, mode = 'wysiwyg') {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => pageErrors.push(String(err)));

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: fileUrl(path.join(ROOT, `__list-marker-${mode}-test__.html`)),
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
  // jsdom 未实现 innerText；fork 的 wysiwyg input 处理器会调用
  // blockElement.innerText.startsWith(...)，缺此 polyfill 会抛错
  if (!('innerText' in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent; },
      set(v) { this.textContent = v; },
    });
  }
  window.HTMLElement.prototype.scrollIntoView = function () { };

  // fork 的 CodeMirror 懒挂载在构造时创建 IntersectionObserver；jsdom 未实现。
  // 测试文档无代码块，观察器无需真实回调
  window.IntersectionObserver = class {
    constructor() { }
    observe() { }
    unobserve() { }
    disconnect() { }
    takeRecords() { return []; }
  };

  // fork 的 editorTheme Auto 检测调用 prefers-color-scheme；jsdom 无 matchMedia
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q, onchange: null,
    addListener() { }, removeListener() { },
    addEventListener() { }, removeEventListener() { },
    dispatchEvent() { return false; },
  }));

  // 预载 Lute 并短路 vditor 的脚本加载器（addScript 以元素 id 去重）
  window.eval(fs.readFileSync(path.join(DIST, 'js', 'lute', 'lute.min.js'), 'utf8'));
  const stubScript = (id) => {
    const s = document.createElement('script');
    s.id = id;
    document.head.appendChild(s);
  };
  stubScript('vditorLuteScript');

  // 预载 i18n，经 options.i18n 直传（constructor 的 i18n 分支免脚本加载）
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
      && document.querySelector(`.vditor-${mode} .vditor-reset`)) {
      return { window, document };
    }
  }
  throw new Error('editor did not boot; page errors: ' + pageErrors.join(' | ').slice(0, 2000));
}

/** ir 模式 boot（#11 探针结论：ir 的 li DOM/属性模型与 wysiwyg 一致） */
const bootIR = (content) => boot(content, 'ir');

/** 将光标放进文本节点的 offset 处并通知 selectionchange（jsdom 不会自动派发） */
function setCaret(window, document, node, offset) {
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new window.Event('selectionchange'));
}

function fireInput(window, target) {
  target.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
}

function fireKey(window, document, key, opts = {}) {
  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, ...opts,
  }));
}

const liveSpan = (doc, li) => (li ? li.querySelector(':scope > span.vmd-li-marker') : null);

/** vditor 把 input 监听挂在 wysiwyg.element（.vditor-wysiwyg 内的 .vditor-reset） */
const editorElOf = (document) =>
  document.querySelector('.vditor-wysiwyg .vditor-reset')
  || document.querySelector('.vditor-wysiwyg');

// ── R/L：Lute 引擎语义栅栏 ────────────────────────────────────────────────

describe('list-marker: Lute engine semantics fence (R/L)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  let ctx;
  before(async () => {
    ctx = await boot(MD);
  });

  it('R1: vditor.vditor.lute.SpinVditorDOM is a function', () => {
    const lute = ctx.window.vditor.vditor.lute;
    assert.equal(typeof lute.SpinVditorDOM, 'function');
  });

  it('R2: vditor.vditor.lute.VditorDOM2Md is a function', () => {
    const lute = ctx.window.vditor.vditor.lute;
    assert.equal(typeof lute.VditorDOM2Md, 'function');
  });

  it('L1: unordered first-li marker change is followed by spin', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const uFollow = lute.SpinVditorDOM('<ul data-block="0" data-marker="-"><li data-marker="*">a</li></ul>');
    assert.match(uFollow, /<ul[^>]*data-marker="\*/);
    assert.match(uFollow, /<li[^>]*data-marker="\*/);
  });

  it('L2: mixed unordered markers split into two lists', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const uSplit = lute.SpinVditorDOM('<ul data-block="0" data-marker="-"><li data-marker="-">a</li><li data-marker="*">b</li></ul>');
    assert.equal((uSplit.match(/<ul/g) || []).length, 2);
  });

  it('L3: ordered start survives spin', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const oKeep = lute.SpinVditorDOM('<ol data-block="0" start="5" data-marker="5."><li data-marker="5.">five</li></ol>');
    assert.match(oKeep, /start="5"/);
    assert.match(oKeep, /data-marker="5\."/);
  });

  it('L4: ordered start round-trips to markdown', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const rt = lute.VditorDOM2Md('<ol data-block="0" start="5" data-marker="5."><li data-marker="5.">five</li><li data-marker="6.">six</li></ol>');
    assert.equal(rt, '5. five\n6. six\n');
  });

  it('L5: paren-delimited list stays separate from dot list', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const sep = lute.VditorDOM2Md(lute.Md2VditorDOM('1. a\n\n5) five\n'));
    assert.equal(sep, '1. a\n\n5) five\n');
  });
});

// ── IL：Lute 引擎语义栅栏（ir 变体，#11 探针） ──────────────────────────
// 探针结论（jsdom + 当前构建实测）：ir 的 li DOM/属性模型与 wysiwyg 完全
// 一致（li 带 data-marker="1." / "-"，ol/ul 带 data-marker），marker 的
// spin 语义（跟随/编号权威/序列化）在 SpinVditorIRDOM 上同样成立；
// marker span 进 IR spin 同样被吞、文本粘进 li 内容（Lute 门必须覆盖
// SpinVditorIRDOM）。以下契约是 ir list marker 编辑（#12）的引擎前置

describe('list-marker: Lute IR semantics fence (IL, #11)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  let ctx;
  before(async () => {
    ctx = await bootIR(MD);
  });

  after(() => {
    ctx.window.close();
  });

  it('IL0: ir 模式 li 的 data-marker 与 wysiwyg 同构', () => {
    const reset = ctx.document.querySelector('.vditor-ir .vditor-reset');
    const ol = reset.querySelector('ol');
    assert.equal(ol.getAttribute('data-marker'), '1.', 'ol data-marker 应与 wysiwyg 同构');
    const markers = Array.from(reset.querySelectorAll('li')).map((li) => li.getAttribute('data-marker'));
    assert.deepEqual(markers, ['1.', '2.', '-', '-']);
  });

  it('IL1: SpinVditorIRDOM is a function（Lute 门需覆盖）', () => {
    const lute = ctx.window.vditor.vditor.lute;
    assert.equal(typeof lute.SpinVditorIRDOM, 'function');
  });

  it('IL2: 无序 first-li marker 改写被 IR spin 跟随', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const uFollow = lute.SpinVditorIRDOM('<ul data-block="0" data-marker="-"><li data-marker="*">a</li></ul>');
    assert.match(uFollow, /<ul[^>]*data-marker="\*/);
    assert.match(uFollow, /<li[^>]*data-marker="\*/);
  });

  it('IL3: 有序编号权威（start + data-marker）在 IR spin 保留', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const oKeep = lute.SpinVditorIRDOM('<ol data-block="0" start="5" data-marker="5."><li data-marker="5.">five</li><li data-marker="6.">six</li></ol>');
    assert.match(oKeep, /start="5"/);
    assert.match(oKeep, /data-marker="5\."/);
  });

  it('IL4: ir 现存列表 DOM 原样回灌稳定（round-trip）', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const ol = ctx.document.querySelector('.vditor-ir .vditor-reset ol');
    const round = lute.SpinVditorIRDOM(ol.outerHTML);
    assert.match(round, /<ol[^>]*data-marker="1\."/);
    assert.equal((round.match(/<li/g) || []).length, 2);
  });

  it('IL5: 编号改写经 VditorDOM2Md 序列化为起始编号', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const md = lute.VditorDOM2Md('<ol data-block="0" start="5" data-marker="5."><li data-marker="5.">a</li></ol>');
    assert.equal(md, '5. a\n');
  });

  it('IL6: marker span 进 IR spin 被吞——文本粘进 li 内容（硬约束不变）', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const span = lute.SpinVditorIRDOM('<ul data-block="0" data-marker="-"><li data-marker="-"><span class="vmd-li-marker">*\u00A0</span>alpha</li></ul>');
    assert.ok(!span.includes('vmd-li-marker'), 'span 不得存活于 IR spin 输出');
    assert.match(span, />.?\*?\u00A0?alpha</, 'span 文本被粘进 li 内容');
  });
});

// ── G/E/U：模块行为契约 ──────────────────────────────────────────────────

describe('list-marker: live marker module contract (G/E/U)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  let ctx;
  before(async () => {
    ctx = await boot(MD);
    // 注入被测模块（缺失即本组全红：TDD 红相位）
    const moduleSource = fs.readFileSync(MODULE_PATH, 'utf8');
    ctx.window.eval(moduleSource);
    ctx.window.ListMarkerLive.install(ctx.window.vditor);
  });

  it('G1: SpinVditorDOM strips marker span and folds value into attributes', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const withSpan = '<ol data-block="0" data-marker="1."><li data-marker="1.">'
      + '<span class="vmd-li-marker">5.\u00A0</span>first</li></ol>';
    const spun = lute.SpinVditorDOM(withSpan);
    assert.ok(!spun.includes('vmd-li-marker'), spun.replace(/\n/g, ''));
    assert.match(spun, /data-marker="5\."/);
    assert.match(spun, /start="5"/);
  });

  it('G2: VditorDOM2Md output has no span text and keeps edited start', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const withSpan = '<ol data-block="0" data-marker="1."><li data-marker="1.">'
      + '<span class="vmd-li-marker">5.\u00A0</span>first</li></ol>';
    const asMd = lute.VditorDOM2Md(withSpan);
    assert.ok(!asMd.includes('vmd-li-marker'));
    assert.ok(!asMd.includes('\u00A0'));
    assert.equal(asMd, '5. first\n');
  });

  it('E1: caret in list line shows live marker span', async () => {
    const { window, document } = ctx;
    const li = document.querySelector('.vditor-wysiwyg ol li');
    setCaret(window, document, li.firstChild, 2);
    await sleep(60);
    const span = liveSpan(document, li);
    assert.ok(span, 'no live span appeared');
    assert.equal(span.textContent, '1.\u00A0');
    assert.ok(li.classList.contains('vmd-marker-live'));
  });

  it('E2: caret move swaps live span to the new line (no stale span)', async () => {
    const { window, document } = ctx;
    const firstLi = document.querySelector('.vditor-wysiwyg ol li');
    const secondLi = document.querySelectorAll('.vditor-wysiwyg ol li')[1];
    setCaret(window, document, secondLi.firstChild, 2);
    await sleep(60);
    assert.ok(!liveSpan(document, firstLi), 'stale span on previous line');
    const s2 = liveSpan(document, secondLi);
    assert.ok(s2);
    assert.equal(s2.textContent, '2.\u00A0');
  });

  it('E3: editing "1." to "5." renumbers the list (markdown + DOM, no leakage)', async () => {
    const { window, document } = ctx;
    const li = document.querySelector('.vditor-wysiwyg ol li');
    setCaret(window, document, li.firstChild, 2);
    await sleep(60);
    const span = liveSpan(document, li);
    assert.ok(span, 'no live span (E1 failed)');
    span.textContent = '5.\u00A0';
    setCaret(window, document, span.firstChild, span.firstChild.textContent.length);
    fireInput(window, editorElOf(document));
    await sleep(60);
    // 延迟提交：input 只吞不提交，span 必须仍在编辑位（即时提交会删 span，
    // 后续键入无处落——用户实测"不能改序号、键入失效"的根源）
    const spanAfterInput = liveSpan(document, li);
    assert.ok(spanAfterInput, 'input 不得即时提交删除 live span');
    assert.equal(spanAfterInput.textContent, '5.\u00A0');
    // Enter 显式提交
    fireKey(window, document, 'Enter');
    await sleep(600); // fork undoDelay 默认 600ms + 余量
    const value = window.vditor.getValue();
    assert.ok(value.startsWith('5. first'), JSON.stringify(value));
    assert.ok(value.includes('6. second'), JSON.stringify(value));
    const ol = document.querySelector('.vditor-wysiwyg ol');
    assert.equal(ol.getAttribute('start'), '5');
    assert.ok(!value.includes('vmd-li-marker'));
    assert.ok(!value.includes('\u00A0'));
  });

  it('E4: editing "-" to "*" changes bullet char', async () => {
    const { window, document } = ctx;
    const li = document.querySelector('.vditor-wysiwyg ul li'); // alpha
    setCaret(window, document, li.firstChild, 2);
    await sleep(60);
    const span = liveSpan(document, li);
    assert.ok(span, 'no live span');
    span.textContent = '*\u00A0';
    setCaret(window, document, span.firstChild, span.firstChild.textContent.length);
    fireInput(window, editorElOf(document));
    await sleep(60);
    assert.ok(liveSpan(document, li), 'input 不得即时提交删除 live span');
    fireKey(window, document, 'Enter');
    await sleep(600);
    const value = window.vditor.getValue();
    assert.match(value, /(^|\n)\* alpha/, JSON.stringify(value));
    assert.doesNotMatch(value, /(^|\n)- alpha/, JSON.stringify(value));
  });

  it('E5: emptying marker lifts the line out of the list', async () => {
    const { window, document } = ctx;
    // E4 后 beta 是仅剩的 "- " 项
    const lis = document.querySelectorAll('.vditor-wysiwyg ul li');
    const beta = lis[lis.length - 1];
    setCaret(window, document, beta.firstChild, 2);
    await sleep(60);
    const span = liveSpan(document, beta);
    assert.ok(span, 'no live span');
    span.textContent = '';
    // caret 放进 span 元素（空 span 无文本节点）：离开折叠逻辑依据
    // "caret 在 span 内"决定不折叠——放在 (li,0) 会被视为已离开 span
    setCaret(window, document, span, 0);
    fireKey(window, document, 'Backspace');
    await sleep(600);
    const value = window.vditor.getValue();
    assert.match(value, /(^|\n)beta/, JSON.stringify(value));
    assert.doesNotMatch(value, /[-*] beta/, JSON.stringify(value));
    const leftover = Array.from(document.querySelectorAll('.vditor-wysiwyg li'))
      .some((li) => li.textContent.replace(/\u00A0/g, ' ').trim() === 'beta');
    assert.ok(!leftover, 'lifted line still has a li');
  });


  // 逐字符 Backspace 删空 marker：span 文本删至 '' 时文本节点消失，
  // 不得因 range.setStart(null) 抛 TypeError，应直接升格段落
  it('E8: char-by-char backspace to empty lifts the item without throwing', async () => {
    const { window, document } = ctx;
    const li = document.querySelector('.vditor-wysiwyg ol li');
    setCaret(window, document, li.firstChild, 2);
    await sleep(60);
    const span = liveSpan(document, li);
    assert.ok(span, 'no live span');
    span.textContent = '5'; // 已删到只剩一个字符
    setCaret(window, document, span.firstChild, 1);
    fireKey(window, document, 'Backspace');
    await sleep(600);
    const value = window.vditor.getValue();
    assert.match(value, /(^|\n)first/, JSON.stringify(value));
    assert.doesNotMatch(value, /5\. first/, JSON.stringify(value));
  });

  // IME composition 期间的 input/keydown（isComposing）不得被模块拦截：
  // 否则输入法确认 Enter 被吞、composition 会话被 commitSpan 销毁。
  // 透传后 vditor 会真实处理事件并重绘 DOM，用独立 boot 隔离
  it('E9: composition events are never intercepted (isComposing guard)', async () => {
    const b5 = await boot(MD);
    const { window: w, document: d } = b5;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);
      const editorEl = editorElOf(d);

      // 透传的 Enter 会让 vditor 拆项重绘，li 集合不可预测：
      // 自适应选第一个内容非空的 li，光标放到其文本末尾
      const focusSpanInFirstLi = async () => {
        const lis = Array.from(d.querySelectorAll('.vditor-wysiwyg ol li'));
        const li = lis.find((l) => l.textContent.trim());
        assert.ok(li, 'no list item with content');
        // 拆项后可能是松散结构（li > p），走真实文本节点而非 li.firstChild
        const walker = d.createTreeWalker(li, 4 /* SHOW_TEXT */);
        let textNode = null;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.textContent.trim()) { textNode = n; break; }
        }
        assert.ok(textNode, 'no text node in li');
        setCaret(w, d, textNode, Math.min(2, textNode.textContent.length));
        await sleep(60);
        const span = liveSpan(d, li);
        assert.ok(span, 'no live span');
        setCaret(w, d, span.firstChild, 1);
        return li;
      };

      // 1) keydown（IME 确认 Enter）
      const li = await focusSpanInFirstLi();
      let keyReached = false;
      const keyProbe = () => { keyReached = true; };
      editorEl.addEventListener('keydown', keyProbe, false);
      const keyEvt = new w.KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      });
      // jsdom 的 KeyboardEvent init 不支持 isComposing，派发前注入
      Object.defineProperty(keyEvt, 'isComposing', { value: true });
      li.dispatchEvent(keyEvt);
      editorEl.removeEventListener('keydown', keyProbe, false);
      assert.strictEqual(keyReached, true, 'IME-confirm Enter was swallowed by the module');

      // 2) input（composition 文本插入；vditor 透传处理可能重绘，重新取节点）
      await focusSpanInFirstLi();
      let inputReached = false;
      const inputProbe = () => { inputReached = true; };
      editorEl.addEventListener('input', inputProbe, false);
      const inputEvt = new w.InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertCompositionText', data: '拼', isComposing: true,
      });
      editorElOf(d).dispatchEvent(inputEvt);
      editorEl.removeEventListener('input', inputProbe, false);
      assert.strictEqual(inputReached, true, 'composition input was swallowed by the module');
    } finally {
      b5.window.close();
    }
  });

  // 光标在正文（非 marker span 内）时，行上仍持有 live span（ensureLive 无条件建），
  // 但按键必须透传给 vditor——拦截条件是“光标在 span 内”而非“行上有 span”。
  // 事件需派发到真实 target（li 元素，冒泡），派发到 document 不会下沉。
  // 透传后 vditor 会真实处理按键并重绘 DOM，用独立 boot 隔离
  it('E7: Enter/Space pass through when caret is in item CONTENT (not in marker span)', async () => {
    const b6 = await boot(MD);
    const { window: w, document: d } = b6;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const li = d.querySelector('.vditor-wysiwyg ol li');
      assert.ok(li, 'no list item');
      // 先触发聚焦（span 建立），再把光标放回正文文本节点（span 之后的兄弟）
      setCaret(w, d, li.firstChild, 2);
      await sleep(60);
      const span = liveSpan(d, li);
      assert.ok(span, 'no live span (precondition)');
      const contentNode = span.nextSibling;
      assert.ok(contentNode && contentNode.nodeType === 3, 'no content text node after span');
      setCaret(w, d, contentNode, 1);

      const editorEl = editorElOf(d);
      for (const key of [' ', 'Enter']) {
        let reachedEditor = false;
        const probe = () => { reachedEditor = true; };
        editorEl.addEventListener('keydown', probe, false);
        const evt = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        const notCancelled = li.dispatchEvent(evt);
        editorEl.removeEventListener('keydown', probe, false);
        // 注：vditor 当前对普通 li 的正文 Enter 不 preventDefault（fixList 仅拦多 P 场景），
        // 因此 defaultPrevented 可完全归因于模块；若 vditor 未来改变此行为需调整断言
        assert.strictEqual(notCancelled, true, `module preventDefault'd content "${key}"`);
        assert.strictEqual(reachedEditor, true, `content "${key}" never reached the editor element (vditor handlers)`);
      }
    } finally {
      b6.window.close();
    }
  });

  // Escape 拦截条件与 Enter/Space 对称：仅 caret 在 marker span 内才拦
  // （放弃编辑）。行上有 span 但 caret 在正文时，Escape 无编辑可放弃，
  // 吞掉会阻断宿主/webview 层的 Escape 语义
  it('E12: Escape passes through when caret is in item CONTENT (not in marker span)', async () => {
    const b7 = await boot(MD);
    const { window: w, document: d } = b7;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const li = d.querySelector('.vditor-wysiwyg ol li');
      setCaret(w, d, li.firstChild, 2);
      await sleep(60);
      const span = liveSpan(d, li);
      assert.ok(span, 'no live span (precondition)');
      const contentNode = span.nextSibling;
      assert.ok(contentNode && contentNode.nodeType === 3, 'no content text node after span');
      setCaret(w, d, contentNode, 1);

      const editorEl = editorElOf(d);
      let reachedEditor = false;
      const probe = () => { reachedEditor = true; };
      editorEl.addEventListener('keydown', probe, false);
      const evt = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      li.dispatchEvent(evt);
      editorEl.removeEventListener('keydown', probe, false);
      // notCancelled 不作断言：vditor 自身对 Escape 有 preventDefault（弹层
      // 关闭逻辑），defaultPrevented 无法归因于模块。模块拦截的标志是
      // stopPropagation 阻断事件到达 editorEl——reachedEditor 即透传证明
      assert.strictEqual(reachedEditor, true, 'content Escape never reached the editor element (module swallowed it)');
    } finally {
      b7.window.close();
    }
  });

  // fork 的任务列表项 li.vditor-task 也带 data-marker（与 checkbox 布局耦合），
  // marker 编辑明确不做（issue #1）：模块不得在任务行激活、CSS 不得画重复标记
  it('E6: task-list items never activate (checkbox layout untouched)', async () => {
    const MD_TASK = '1. first\n\n- [x] done\n- [ ] todo\n';
    const b3 = await boot(MD_TASK);
    const { window: w, document: d } = b3;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const taskLi = d.querySelector('.vditor-wysiwyg li.vditor-task');
      assert.ok(taskLi, 'no task item rendered');
      assert.ok(taskLi.hasAttribute('data-marker'), 'fork task li has no data-marker; revisit guard');

      setCaret(w, d, taskLi.firstChild, 0);
      await sleep(60);
      assert.ok(!liveSpan(d, taskLi), 'live span appeared inside a task item');
      assert.equal(d.querySelectorAll('.vditor-wysiwyg .vmd-li-marker').length, 0,
        'stray marker spans after focusing a task item');

      const value = w.vditor.getValue();
      assert.ok(/- \[[xX]\] done/.test(value), JSON.stringify(value));
      assert.ok(/- \[ \] todo/.test(value), JSON.stringify(value));
    } finally {
      b3.window.close();
    }
  });

  // fork undo 栈存 innerHTML 快照；undo 需 ≥2 条目，marker 编辑前先做一次普通编辑
  it('U0-U2: undo restores pre-marker-edit markdown without span leakage', async () => {
    const MD_U = '1. first\n2. second\n\npara\n';
    const MD_U_TYPED = '1. first\n2. second\n\nparaX\n';
    const b2 = await boot(MD_U);
    const { window: w, document: d } = b2;
    try {
      // 模块按 window 安装（监听器挂在各自 document 上）：第二窗口需重新注入
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      // 1) 普通编辑：para 结尾输入 X（建立栈）
      const para = d.querySelector('.vditor-wysiwyg p');
      assert.ok(para, 'no paragraph');
      para.firstChild.textContent = 'paraX';
      setCaret(w, d, para.firstChild, 5);
      editorElOf(d).dispatchEvent(new w.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'X' }));
      await sleep(1200);

      // 2) marker 编辑：1. → 7.
      const li = d.querySelector('.vditor-wysiwyg ol li');
      setCaret(w, d, li.firstChild, 2);
      await sleep(60);
      const span = liveSpan(d, li);
      assert.ok(span, 'no live span appeared');
      span.textContent = '7.\u00A0';
      setCaret(w, d, span.firstChild, span.firstChild.textContent.length);
      editorElOf(d).dispatchEvent(new w.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
      await sleep(60);
      // 延迟提交设计：Enter 显式提交（input 只吞不提交）
      d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(1200); // undoDelay 期间快照可能仍含 span——契约是恢复后干净
      assert.ok(w.vditor.getValue().startsWith('7. first'), 'renumber not applied');

      // 直调 undo 栈（Ctrl+Z 在有 undo 工具栏按钮时被跳过；契约是快照/恢复干净度）
      w.vditor.vditor.undo.undo(w.vditor.vditor);
      await sleep(300);
      const v = w.vditor.getValue();
      assert.equal(v, MD_U_TYPED, JSON.stringify(v));
      assert.ok(!v.includes('vmd-li-marker'), 'span class leaked into undo-restored markdown');
      assert.ok(!v.includes('\u00A0'), 'nbsp leaked into undo-restored markdown');
    } finally {
      b2.window.close();
    }
  });
});

// ── IE：模块行为契约（ir 变体，#12） ────────────────────────────────────
// 与 G/E/U 组同源的场景在 ir 模式重跑：live 激活 / 换行清扫 / 重编号 /
// 升格 / undo 干净度。#11 探针已证 ir 与 wysiwyg 的列表 DOM 模型一致，
// 此组验证模块的 mode 守卫与 Lute 门（SpinVditorIRDOM）在 ir 管线生效

describe('list-marker: live marker in ir mode (IE, #12)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  let ctx;
  before(async () => {
    ctx = await bootIR(MD);
    ctx.window.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
    ctx.window.ListMarkerLive.install(ctx.window.vditor);
  });

  after(() => {
    ctx.window.close();
  });

  const editorElIR = (doc) =>
    doc.querySelector('.vditor-ir .vditor-reset') || doc.querySelector('.vditor-ir');

  it('IE1: ir 光标进列表行 → live span 激活', async () => {
    const { window, document } = ctx;
    const li = document.querySelector('.vditor-ir ol li');
    setCaret(window, document, li.firstChild, 2);
    await sleep(60);
    const span = liveSpan(document, li);
    assert.ok(span, 'ir 模式未激活 live span');
    assert.equal(span.textContent, '1.\u00A0');
    assert.ok(li.classList.contains('vmd-marker-live'));
  });

  it('IE2: ir 光标换行清扫旧 span', async () => {
    const { window, document } = ctx;
    const firstLi = document.querySelector('.vditor-ir ol li');
    const secondLi = document.querySelectorAll('.vditor-ir ol li')[1];
    setCaret(window, document, secondLi.firstChild, 2);
    await sleep(60);
    assert.ok(!liveSpan(document, firstLi), 'ir 上一行残留 stale span');
    const s2 = liveSpan(document, secondLi);
    assert.ok(s2, 'ir 新行无 span');
    assert.equal(s2.textContent, '2.\u00A0');
  });

  it('IE2b: Lute 门覆盖粘贴回灌与导出路径（fold 而非粘内容）', () => {
    const lute = ctx.window.vditor.vditor.lute;
    const withSpan = '<ul data-block="0" data-marker="-"><li data-marker="-"><span class="vmd-li-marker">*\u00A0</span>alpha</li></ul>';
    // 区分门与引擎天然吞并：门先剥 span 并 fold 值进 data-marker，内容
    // 保持 alpha；引擎天然吞并会把 "* " 粘进 li 内容（实测未包门输出
    // 为 "* alpha" / "*** **alpha"）
    ['HTML2VditorDOM', 'HTML2VditorIRDOM'].forEach((name) => {
      if (typeof lute[name] !== 'function') return;
      const out = String(lute[name](withSpan));
      assert.ok(!out.includes('vmd-li-marker'), `${name} 输出不得含 marker span`);
      assert.match(out, /data-marker="\*"/, `${name} 应把 span 值 fold 进 data-marker`);
      assert.ok(!out.includes('*alpha'), `${name} 内容不得粘入 marker 文本`);
    });
    ['VditorDOM2HTML', 'VditorIRDOM2HTML'].forEach((name) => {
      if (typeof lute[name] !== 'function') return;
      const out = String(lute[name](withSpan));
      assert.ok(!out.includes('vmd-li-marker'), `${name} 输出不得含 marker span`);
      assert.ok(!/\*\s?alpha/.test(out), `${name} 内容不得粘入 marker 文本`);
    });
  });

  it('IE3: ir 编辑 "1." → "5." 重编号（markdown + DOM，无 span 泄漏）', async () => {
    const { window, document } = ctx;
    const li = document.querySelector('.vditor-ir ol li');
    setCaret(window, document, li.firstChild, 2);
    await sleep(60);
    const span = liveSpan(document, li);
    assert.ok(span, 'no live span in ir');
    span.textContent = '5.\u00A0';
    setCaret(window, document, span.firstChild, span.firstChild.textContent.length);
    fireInput(window, editorElIR(document));
    await sleep(60);
    assert.ok(liveSpan(document, li), 'input 不得即时提交删除 live span');
    fireKey(window, document, 'Enter');
    await sleep(600);
    const value = window.vditor.getValue();
    assert.ok(value.startsWith('5. first'), JSON.stringify(value));
    assert.ok(value.includes('6. second'), JSON.stringify(value));
    assert.ok(!value.includes('vmd-li-marker'), 'span 泄漏进 ir markdown');
    assert.ok(!value.includes('\u00A0'), 'nbsp 泄漏进 ir markdown');
  });

  it('IE4: ir 清空 marker 升格出列表', async () => {
    const { window, document } = ctx;
    const beta = Array.from(document.querySelectorAll('.vditor-ir ul li')).pop();
    setCaret(window, document, beta.firstChild, 2);
    await sleep(60);
    const span = liveSpan(document, beta);
    assert.ok(span, 'no live span in ir');
    span.textContent = '';
    // 同 E5：caret 放进空 span 元素，避免被离开折叠逻辑处理
    setCaret(window, document, span, 0);
    fireKey(window, document, 'Backspace');
    await sleep(600);
    const value = window.vditor.getValue();
    assert.match(value, /(^|\n)beta/, JSON.stringify(value));
    assert.doesNotMatch(value, /[-*] beta/, JSON.stringify(value));
  });

  it('IE5: ir marker 编辑进 undo 栈，恢复快照无泄漏', async () => {
    // undo 需要 undoStack ≥2 条目才动作（两模式一致；boot 快照经
    // undoDelay 约 600ms 异步入栈，测试时点可能未及）：先做一次普通
    // 编辑建立栈基线，undo 一次应回滚 marker 编辑而保留普通编辑
    // （与 U0-U2 同构）
    const MD_IE = '1. first\n2. second\n\npara\n';
    const MD_IE_TYPED = '1. first\n2. second\n\nparaX\n';
    const b5 = await bootIR(MD_IE);
    const { window: w, document: d } = b5;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      // 1) 普通编辑建立栈基线
      const para = d.querySelector('.vditor-ir p[data-block="0"]');
      assert.ok(para, 'no paragraph in ir');
      para.firstChild.textContent = 'paraX';
      const setCaretIE = (node, offset) => {
        const sel = w.getSelection();
        const range = d.createRange();
        range.setStart(node, offset);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        d.dispatchEvent(new w.Event('selectionchange'));
      };
      setCaretIE(para.firstChild, 5);
      editorElIR(d).dispatchEvent(new w.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'X' }));
      await sleep(1200);

      // 2) marker 编辑：1. → 7.
      const li = d.querySelector('.vditor-ir ol li');
      setCaretIE(li.firstChild, 2);
      await sleep(60);
      const span = liveSpan(d, li);
      assert.ok(span, 'no live span in ir');
      span.textContent = '7.\u00A0';
      setCaretIE(span.firstChild, span.firstChild.textContent.length);
      editorElIR(d).dispatchEvent(new w.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
      await sleep(60);
      // 延迟提交设计：Enter 显式提交（input 只吞不提交）
      d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(1200);
      assert.ok(w.vditor.getValue().startsWith('7. first'), 'ir renumber not applied');

      w.vditor.vditor.undo.undo(w.vditor.vditor);
      await sleep(300);
      const v = w.vditor.getValue();
      assert.equal(v, MD_IE_TYPED, JSON.stringify(v));
      assert.ok(!v.includes('vmd-li-marker'), 'span 泄漏进 ir undo 恢复');
      assert.ok(!v.includes('\u00A0'), 'nbsp 泄漏进 ir undo 恢复');
    } finally {
      b5.window.close();
    }
  });

  it('IE6: 空列表项聚焦不激活 live span，caret 保留可输入位置', async () => {
    // 空 li 零子节点（<li data-marker="3."></li>），原生点击唯一落点
    // 是 (li, 0)。若给空项注入 marker span，span 成为唯一子节点，浏览
    // 器对元素间隙 caret 的规范化会把任何 li 内位置归一到 span 文本
    // 里——打字进 span 被 input capture 吞掉（parseMarker 失败静默丢
    // 弃，字符消失）、Backspace 被逐字符删 marker 而非删除整项（用户
    // 实测：无法键入、空项删不掉）。契约：空内容项不 span 化，marker
    // 保持 CSS 渲染，vditor 原生的"打字进内容 / Backspace 删项"路径完
    // 全保留；有内容项不受影响（span 照常激活）
    const b6 = await bootIR('1. first\n2. second\n3. \n');
    const { window: w, document: d } = b6;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const lis = [...d.querySelectorAll('.vditor-ir ol li')];
      const emptyLi = lis.find((li) => (li.textContent || '').replace(/[\u200B\u00A0\s]/g, '') === '');
      assert.ok(emptyLi, '空列表项未找到');
      assert.equal(emptyLi.childNodes.length, 0, '空项应零子节点（哨兵也不该有）');

      // 点击空项（原生落点 (li, 0) 的程序化等价）
      setCaret(w, d, emptyLi, 0);
      await sleep(60);

      assert.equal(liveSpan(d, emptyLi), null, '空项聚焦后不得出现 live span');
      assert.equal(emptyLi.classList.contains('vmd-marker-live'), false, '空项不得挂 live 类');
      const sel = w.getSelection();
      assert.ok(sel.anchorNode === emptyLi || emptyLi.contains(sel.anchorNode),
        `caret 应留在空项内，实际 ${sel.anchorNode && sel.anchorNode.nodeName}@${sel.anchorOffset}`);

      // 对照：有内容项聚焦 span 照常激活
      setCaret(w, d, lis[0].firstChild, 2);
      await sleep(60);
      assert.ok(liveSpan(d, lis[0]), '有内容项聚焦应激活 live span');
    } finally {
      b6.window.close();
    }
  });

  it('IE10: marker 键入不再逐字符即时提交——多字符编辑可行', async () => {
    // 用户改序号的真实操作流：caret 进 span → 连续编辑多个字符 →
    // Enter 确认。旧实现每字符 input 即 commitSpan（删 span、caret 跳
    // 内容起点）：第二个字符落进正文或 parseMarker 失败被静默丢弃——
    // 用户实测"不能改序号、键入失效"。契约：input 只吞不提交，span
    // 全程保留编辑态；Enter 一次性提交，marker 与内容干净
    const b7 = await bootIR('1. first\n2. second\n');
    const { window: w, document: d } = b7;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const li = d.querySelector('.vditor-ir ol li');
      setCaret(w, d, li.firstChild, 2);
      await sleep(60);
      let span = liveSpan(d, li);
      assert.ok(span, 'no live span in ir');

      // 模拟两次连续键入（jsdom 无默认编辑，手动写 textContent 等价）：
      // "1." 的 "1" 后插 "5" → "15.\u00A0"
      span.textContent = '15.\u00A0';
      setCaret(w, d, span.firstChild, 2);
      fireInput(w, editorElIR(d));
      await sleep(60);
      span = liveSpan(d, li);
      assert.ok(span, '第一次键入后 span 不得被即时提交删除');
      assert.equal(span.textContent, '15.\u00A0');
      // 未提交：data-marker 属性保持旧值
      assert.equal(li.getAttribute('data-marker'), '1.', '未提交前 data-marker 不变');

      fireKey(w, d, 'Enter');
      await sleep(600);
      const value = w.vditor.getValue();
      assert.ok(value.startsWith('15. first'), JSON.stringify(value));
      assert.ok(value.includes('16. second'), JSON.stringify(value));
      assert.ok(!value.includes('vmd-li-marker'), 'span 泄漏进 ir markdown');
      assert.ok(!value.includes('\u00A0'), 'nbsp 泄漏进 ir markdown');
    } finally {
      b7.window.close();
    }
  });

  it('IE11: caret 离开 marker span 折叠提交；非法中间态回退旧值', async () => {
    // 提交的第二通道：caret 离开 span（点到正文/别的行）时把 span 文本
    // 折叠进 data-marker（非法则回退旧值），不派发 input、不抢 caret。
    // getValue 直读 DOM 属性序列化，折叠结果保存语义正确
    const b8 = await bootIR('1. first\n2. second\n');
    const { window: w, document: d } = b8;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const li = d.querySelector('.vditor-ir ol li');
      setCaret(w, d, li.firstChild, 2);
      await sleep(60);
      let span = liveSpan(d, li);
      assert.ok(span, 'no live span in ir');
      const content = span.nextSibling;
      assert.ok(content && content.nodeType === 3, '内容文本节点缺失');

      // 键入合法 marker 后点到正文（caret 离开 span、仍在行内）
      span.textContent = '5.\u00A0';
      setCaret(w, d, span.firstChild, 2);
      fireInput(w, editorElIR(d));
      await sleep(60);
      setCaret(w, d, content, 1);
      await sleep(60);

      assert.equal(li.getAttribute('data-marker'), '5.', '离开 span 应折叠提交 marker');
      const ol = d.querySelector('.vditor-ir ol');
      assert.equal(ol.getAttribute('start'), '5', '首项应同步 ol start');
      // 下游同步：后续 li 的 data-marker 连续重编，与 Enter 通道产出一致
      // （否则 getValue 输出 "5. first\n2. second"，回灌又被 spin 归一为
      // 6.——保存文本与后续显示不一致）
      const lis = [...ol.children];
      assert.equal(lis[1].getAttribute('data-marker'), '6.', '次项 data-marker 应连续重编');
      const value = w.vditor.getValue();
      assert.ok(value.startsWith('5. first'), JSON.stringify(value));
      assert.ok(value.includes('6. second'), '次项应序列化为 6.：' + JSON.stringify(value));
      assert.ok(!value.includes('vmd-li-marker'), 'span 泄漏进 ir markdown');
      // 行仍聚焦：ensureLive 重建 span 显示新 marker
      span = liveSpan(d, li);
      assert.ok(span, '行内聚焦应重建 live span');
      assert.equal(span.textContent, '5.\u00A0', '重建 span 应显示新 marker');

      // 非法中间态（删了数字还没输完）：离开 → 回退旧值，不写入
      span.textContent = '.\u00A0';
      setCaret(w, d, span.firstChild, 1);
      fireInput(w, editorElIR(d));
      await sleep(60);
      setCaret(w, d, content, 1);
      await sleep(60);
      assert.equal(li.getAttribute('data-marker'), '5.', '非法中间态离开应回退旧值');
      span = liveSpan(d, li);
      assert.ok(span, '行内聚焦应保持 live span');
      assert.equal(span.textContent, '5.\u00A0', '回退后 span 应显示旧 marker');
    } finally {
      b8.window.close();
    }
  });

  it('IE12: Escape 放弃进行中的 marker 编辑', async () => {    // Escape 丢弃 span 内未提交的编辑，恢复旧 marker。真机 selectionchange
    // 异步触发可能令 ensureLive 立即重建行内 span（显示旧值）——契约兼容
    // 两种形态：span 不存在，或存在且文本为旧值
    const b9 = await bootIR('1. first\n2. second\n');
    const { window: w, document: d } = b9;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const li = d.querySelector('.vditor-ir ol li');
      setCaret(w, d, li.firstChild, 2);
      await sleep(60);
      const span = liveSpan(d, li);
      assert.ok(span, 'no live span in ir');
      span.textContent = '5.\u00A0';
      setCaret(w, d, span.firstChild, 2);

      fireKey(w, d, 'Escape');
      await sleep(60);
      assert.equal(li.getAttribute('data-marker'), '1.', 'Escape 后 marker 应保持旧值');
      const after = liveSpan(d, li);
      if (after) {
        assert.equal(after.textContent, '1.\u00A0', '重建的 span 必须显示旧 marker');
      }
      const value = w.vditor.getValue();
      assert.ok(value.startsWith('1. first'), JSON.stringify(value));
      assert.ok(!value.includes('vmd-li-marker'), 'span 泄漏进 ir markdown');
    } finally {
      b9.window.close();
    }
  });

  it('IE13: 非首项 fold 不写入——与 Lute 权威（ol start / ul 首项）对齐', async () => {
    // Lute 的编号/符号权威在 ol start 与首项 data-marker：中间项的手改
    // 在 Enter 通道会被 spin 当场归一回顺序编号。fold 若也写入中间项，
    // CSS/保存先显示新值、下次任意输入触发 spin 时被静默重写回旧值
    // （ol）或列表分裂（ul）——延迟引爆。契约：非首项 fold 一律不写入
    // （观感与 Enter 通道一致：改号不生效）
    const b10 = await bootIR('1. first\n2. second\n3. third\n');
    const { window: w, document: d } = b10;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const lis = [...d.querySelectorAll('.vditor-ir ol li')];
      setCaret(w, d, lis[1].firstChild, 2);
      await sleep(60);
      let span = liveSpan(d, lis[1]);
      assert.ok(span, '中间项聚焦应激活 live span');
      const content = span.nextSibling;
      assert.ok(content && content.nodeType === 3, '内容文本节点缺失');

      span.textContent = '9.\u00A0';
      setCaret(w, d, span.firstChild, 2);
      fireInput(w, editorElIR(d));
      await sleep(60);
      setCaret(w, d, content, 1);
      await sleep(60);

      assert.equal(lis[1].getAttribute('data-marker'), '2.', '非首项 fold 不得写入 data-marker');
      const value = w.vditor.getValue();
      assert.ok(value.includes('2. second'), JSON.stringify(value));
      assert.ok(!value.includes('9. second'), '非首项改号不得进 markdown');
      span = liveSpan(d, lis[1]);
      assert.ok(span, '行内聚焦应保持 live span');
      assert.equal(span.textContent, '2.\u00A0', '回退后 span 应显示旧 marker');
    } finally {
      b10.window.close();
    }
  });

  it('IE14: 跨行离开（stale 清扫）同样折叠提交', async () => {
    // 用户改完 marker 直接点另一行：onSelectionChange 的 stale 循环走
    // foldLive。若该循环退化为 clearLive（丢 applyMarker），编辑会静默
    // 丢失——本契约锁定跨行路径的提交语义
    const b11 = await bootIR('1. first\n2. second\n');
    const { window: w, document: d } = b11;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const lis = [...d.querySelectorAll('.vditor-ir ol li')];
      setCaret(w, d, lis[0].firstChild, 2);
      await sleep(60);
      const span = liveSpan(d, lis[0]);
      assert.ok(span, 'no live span in ir');
      span.textContent = '5.\u00A0';
      setCaret(w, d, span.firstChild, 2);
      fireInput(w, editorElIR(d));
      await sleep(60);

      // 点到另一行（A 行成为 stale）
      setCaret(w, d, lis[1].firstChild, 2);
      await sleep(60);

      assert.equal(lis[0].getAttribute('data-marker'), '5.', '跨行离开应折叠提交');
      const value = w.vditor.getValue();
      assert.ok(value.startsWith('5. first'), JSON.stringify(value));
      assert.ok(liveSpan(d, lis[1]), '新行聚焦应激活 live span');
    } finally {
      b11.window.close();
    }
  });

  it('IE15: fold 提交触发宿主保存通知（options.input）', async () => {
    // fold 不派发 DOM input（避免 spin 抢 caret），但宿主的保存链路
    // 完全依赖 vditor options.input 回调上报（index.js → emit("save") →
    // scheduleDocumentSync）。不通知则文档不 dirty：Ctrl+S 不落盘、
    // 关面板无未保存提示，marker 编辑静默丢失。契约：fold 写入成功时
    // 以 getValue() 直调 options.input 上报一次
    const b12 = await bootIR('1. first\n2. second\n');
    const { window: w, document: d } = b12;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const li = d.querySelector('.vditor-ir ol li');
      setCaret(w, d, li.firstChild, 2);
      await sleep(60);
      const span = liveSpan(d, li);
      assert.ok(span, 'no live span in ir');
      const content = span.nextSibling;

      // spy：包一层 options.input 计数并捕获内容
      const orig = w.vditor.vditor.options.input;
      let calls = 0;
      let lastContent = '';
      w.vditor.vditor.options.input = (md) => {
        calls += 1;
        lastContent = md;
      };

      span.textContent = '5.\u00A0';
      setCaret(w, d, span.firstChild, 2);
      fireInput(w, editorElIR(d));
      await sleep(60);
      assert.equal(calls, 0, '编辑中的 input 吞掉不得上报');

      setCaret(w, d, content, 1);
      await sleep(60);
      assert.ok(calls >= 1, 'fold 写入成功应触发保存通知');
      assert.ok(String(lastContent).startsWith('5. first'),
        '上报内容应含新 marker：' + JSON.stringify(String(lastContent).slice(0, 40)));

      w.vditor.vditor.options.input = orig;
    } finally {
      b12.window.close();
    }
  });

  it('IE16: 跨行点击 marker——caret 精确落在点击点（caretPositionFromPoint）', async () => {
    // 首次跨行点击 marker 时它还是 CSS ::before（非 DOM），浏览器只能把
    // caret 放到 (li,0)；注入 span 后的粗粒度 nudge (li,1) 经浏览器规范化
    // 落在句号后——点击的精确坐标丢失（用户实测：第一次点击 caret 不落
    // 点击处，要点的第二次才准）。契约：mousedown 坐标被记录，span 注入
    // 后经 caretPositionFromPoint 还原精确偏移
    const b13 = await bootIR('1. first\n2. second\n3. third\n');
    const { window: w, document: d } = b13;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const lis = [...d.querySelectorAll('.vditor-ir ol li')];
      // 先激活另一行（跨行场景）
      setCaret(w, d, lis[1].firstChild, 2);
      await sleep(60);
      assert.equal(liveSpan(d, lis[0]), null, '前置：首项未激活');

      // polyfill caretPositionFromPoint：模拟点击点命中首项 marker 文本 offset 1
      let probeCalls = 0;
      d.caretPositionFromPoint = () => {
        probeCalls += 1;
        const sp = liveSpan(d, lis[0]);
        return sp ? { offsetNode: sp.firstChild, offset: 1 } : null;
      };

      // 模拟 mousedown 记录坐标 + caret 落 (li,0)（浏览器对 ::before 的唯一可放位置）
      d.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 80 }));
      setCaret(w, d, lis[0], 0);
      await sleep(60);

      assert.ok(probeCalls >= 1, '应调用 caretPositionFromPoint 还原点击点');
      const sp = liveSpan(d, lis[0]);
      assert.ok(sp, 'span 应建立');
      const sel = w.getSelection();
      assert.equal(sel.anchorNode, sp.firstChild, 'caret 应落在 span 文本内');
      assert.equal(sel.anchorOffset, 1, 'caret 应落在点击的精确偏移');
    } finally {
      b13.window.close();
    }
  });

  it('IE17: 无命中坐标时退回 (li,1) nudge，不产生空 caret', async () => {
    // caretPositionFromPoint 未命中 span（键盘 Home 到行首 / 坐标过期 /
    // 命中 li 本身）时保持现有 nudge 行为——caret 不得悬空或丢失
    const b14 = await bootIR('1. first\n2. second\n');
    const { window: w, document: d } = b14;
    try {
      w.eval(fs.readFileSync(MODULE_PATH, 'utf8'));
      w.ListMarkerLive.install(w.vditor);

      const lis = [...d.querySelectorAll('.vditor-ir ol li')];
      setCaret(w, d, lis[1].firstChild, 2);
      await sleep(60);
      // polyfill 返回 null（坐标无法命中）
      d.caretPositionFromPoint = () => null;

      d.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 80 }));
      setCaret(w, d, lis[0], 0);
      await sleep(60);

      const sp = liveSpan(d, lis[0]);
      assert.ok(sp, 'span 应建立');
      const sel = w.getSelection();
      assert.equal(sel.anchorNode, lis[0], '退回 nudge：caret 应在 (li,1)');
      assert.equal(sel.anchorOffset, 1, '退回 nudge：caret 应在 (li,1)');
    } finally {
      b14.window.close();
    }
  });
});

// ── C：CSS 契约 ──────────────────────────────────────────────────────────

describe('list-marker: CSS contract (C)', () => {
  let css;
  before(() => {
    css = fs.readFileSync(CSS_PATH, 'utf8');
  });

  it('C1: native markers hidden for data-block lists', () => {
    assert.match(css, /ol\[data-block\][^{}]*\{[^}]*list-style:\s*none/);
    assert.match(css, /ul\[data-block\][^{}]*\{[^}]*list-style:\s*none/);
  });

  it('C2: li::before renders marker from attr (task items excluded)', () => {
    assert.match(css, /li\[data-marker\]:not\(\.vditor-task\):?:before[^{]*\{[^}]*attr\(data-marker\)/);
  });

  it('C3: live-line class and span styled', () => {
    assert.match(css, /vmd-marker-live/);
    assert.match(css, /vmd-li-marker/);
  });

  it('C4: marker color follows the fork list-marker variable', () => {
    assert.match(css, /data-marker\][^{]*:?:before[^}]*--list-marker-color/);
  });
  it('C5: live span mirrors the ::before box model (no focus jitter)', () => {
    // 聚焦时 span 接管 ::before，两者占位须一致，否则正文起点跳动
    assert.match(css, /\.vmd-li-marker[^{]*\{[^}]*display:\s*inline-block/);
    assert.match(css, /\.vmd-li-marker[^{]*\{[^}]*min-width:\s*1\.5em/);
    assert.match(css, /\.vmd-li-marker[^{]*\{[^}]*margin-left:\s*-1\.8em/);
  });
});

// ── W：接线契约 ──────────────────────────────────────────────────────────

describe('list-marker: wiring contract (W)', () => {
  it('W1: index.html loads list-marker.js before index.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'resource', 'markdown', 'index.html'), 'utf8');
    const lm = html.indexOf('list-marker.js');
    assert.ok(lm > 0, 'list-marker.js script tag missing');
    assert.ok(html.indexOf('index.js') > lm, 'list-marker.js must load before index.js');
  });

  it('W2: index.js installs the module in after()', () => {
    const js = fs.readFileSync(path.join(ROOT, 'resource', 'markdown', 'index.js'), 'utf8');
    assert.match(js, /ListMarkerLive\.install\(editor\)/);
  });
});
