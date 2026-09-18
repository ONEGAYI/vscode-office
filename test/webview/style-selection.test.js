'use strict';

/**
 * Webview 集成测试 — 工具栏样式操作后的选区保留（fix/selection-retention）
 *
 * 背景：vditor 的 DOM 变更路径以单点 <wbr> 锚 + setRangeByWbr（一律 collapse）
 * 恢复光标，无法表达选区范围。列表/引用（listToggle/quote 的 outerHTML 替换）
 * 与 IR 内联样式（processToolbar 的 prefix+text+suffix 插入）在选中文本操作后
 * 选区塌缩，导致无法连续叠加样式（如加粗后再斜体），IR 连续操作还会留下
 * 裸 `**` 污染正文。
 *
 * 修复契约：上述操作前保存文本偏移，DOM 替换后的同步段内重建非 collapsed
 * 选区；collapsed 光标操作保持既有行为不变；undo 快照与重建选区兼容。
 *
 * 前置：需先构建 vditor 子包（vditor/dist 不入库）。未构建时整组跳过。
 *
 * jsdom 注意（同 list-ops.test.js）：选区起止必须落在文本节点上，且需手动
 * 派发 selectionchange（jsdom 不自动派发）。
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

const MD = 'first para words\n\nsecond para here\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIST_READY = fs.existsSync(path.join(DIST, 'index.min.js'))
  && fs.existsSync(path.join(DIST, 'js', 'lute', 'lute.min.js'));

const fileUrl = (p) => 'file://' + p.replace(/\\/g, '/');

/** 以真实构建产物启动编辑器（照 list-ops.test.js 的 boot 模式） */
async function boot(content, { mode = 'wysiwyg' } = {}) {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => pageErrors.push(String(err)));

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: fileUrl(path.join(ROOT, '__style-selection-test__.html')),
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
    toolbar: ['bold', 'italic', 'strike', 'inline-code', 'list', 'ordered-list', 'check', 'quote'],
    after() { booted = true; },
  });

  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (booted
      && window.vditor.getCurrentMode && window.vditor.getCurrentMode() === mode
      && document.querySelector(`.vditor-${mode} .vditor-reset`)) {
      return { window, document, mode };
    }
  }
  throw new Error('editor did not boot; page errors: ' + pageErrors.join(' | ').slice(0, 2000));
}

/** 当前模式编辑面（顶层块的父元素） */
const resetEl = (ctx) => ctx.document.querySelector(`.vditor-${ctx.mode} .vditor-reset`);

/** 顶层段落块（不含哨兵 span），按文档序 */
const paras = (ctx) => Array.from(resetEl(ctx).querySelectorAll('p[data-block="0"]'))
  .filter((p) => p.textContent.trim() !== '');

/** 深入到元素内首个文本节点（ir 的 p 首子可能是 marker/内联元素） */
function deepestFirstChild(el) {
  let node = el.firstChild || el;
  while (node && node.nodeType === 1 && node.firstChild) {
    node = node.firstChild;
  }
  return node;
}

/** 选中文本子串（同块内）：定位包含 text 的文本节点，选中该子串 */
function selectTextIn(ctx, el, text) {
  const { window, document } = ctx;
  const walker = document.createTreeWalker(el, window.NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const idx = node.textContent.indexOf(text);
    if (idx >= 0) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new window.Event('selectionchange'));
      return true;
    }
  }
  return false;
}

/** 光标塌缩到块内文本指定偏移 */
function setCaretIn(ctx, el, offset) {
  const { window, document } = ctx;
  const node = deepestFirstChild(el);
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new window.Event('selectionchange'));
}

/** 与 hotkeyEvent 分发器同款：向 MenuItem 内部按钮派发 click CustomEvent */
function clickToolbar(ctx, name) {
  const btn = ctx.window.vditor.vditor.toolbar.elements[name].children[0];
  btn.dispatchEvent(new ctx.window.CustomEvent('click'));
}

/** 派发编辑键（hotkeyEvent 绑定在编辑面上；Windows 下 ⌘=ctrl） */
function fireKey(ctx, key, opts = {}) {
  resetEl(ctx).dispatchEvent(new ctx.window.KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, ctrlKey: true, ...opts,
  }));
}

const settle = () => sleep(150);
const selOf = (ctx) => ctx.window.getSelection();
/** 过滤 ZWSP 后的选中文本（setRangeByWbr 的 Chrome 分支会补 ZWSP） */
const selText = (ctx) => selOf(ctx).toString().replace(/\u200b/g, '');

// ── S：IR 内联样式选区保留 ───────────────────────────────────────────────

describe('style-selection: IR inline styles keep selection (S)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  let ctx;
  before(async () => {
    ctx = await boot(MD, { mode: 'ir' });
  });

  it('S1: 选中子串加粗 → strong 生效且选区仍为非折叠同文选区', async () => {
    const p = paras(ctx)[0];
    assert.ok(selectTextIn(ctx, p, 'first para'), '前置：应能选中 first para 子串');

    fireKey(ctx, 'b');
    await settle();

    assert.match(ctx.window.vditor.getValue(), /\*\*first para\*\*/, '加粗应生效');
    const sel = selOf(ctx);
    assert.ok(sel.rangeCount > 0, '选区不应消失');
    assert.equal(sel.isCollapsed, false, '加粗后选区不应塌缩');
    assert.equal(selText(ctx), 'first para', '选中文本不应漂移');
  });

  it('S2: 加粗后接斜体 → 嵌套强调生效，正文无裸 ** 污染', async () => {
    // 独立 boot：S1 会把 bold 按钮置 current，共用 ctx 时 S2 的 Ctrl+B
    // 会命中"移除"分支（按钮状态在选区迁移后由 selectionchange 重算，
    // jsdom 内连续 fireKey 等不到重算），无法验证连续叠加
    const s2ctx = await boot(MD, { mode: 'ir' });
    try {
      const p = paras(s2ctx)[1];
      assert.ok(selectTextIn(s2ctx, p, 'second para'), '前置：应能选中 second para 子串');

      fireKey(s2ctx, 'b');
      await settle();
      fireKey(s2ctx, 'i');
      await settle();

      // jsdom 中 ir 的 spin 重渲染分支不执行（DOM 保持 **text** 文本形态），
      // 故以 markdown 序列化断言嵌套语义：***second para*** 为正确嵌套输出，
      // 裸 ** 污染形态（如 **text **text**）不会匹配该模式
      const md = s2ctx.window.vditor.getValue();
      assert.match(md, /\*\*\*second para\*\*\*/, '斜体应嵌套叠加在加粗之上（无裸 ** 污染）');
      const sel = selOf(s2ctx);
      assert.ok(sel.rangeCount > 0, '连续操作后选区不应消失');
      assert.equal(sel.isCollapsed, false, '连续操作后选区仍保留');
      assert.ok(sel.toString().includes('second para'), '选区应覆盖原文本');
    } finally {
      s2ctx.window.close();
    }
  });

  it('S3: 光标塌缩时加粗 → 维持既有空标记行为（回归保护）', async () => {
    const sctx = await boot(MD, { mode: 'ir' });
    try {
      const p = paras(sctx)[0];
      setCaretIn(sctx, p, 6);

      fireKey(sctx, 'b');
      await settle();

      assert.equal(selOf(sctx).isCollapsed, true, '塌缩光标操作后应保持塌缩');
      assert.match(sctx.window.vditor.getValue(), /\*\*\s?\*\*/);
    } finally {
      sctx.window.close();
    }
  });
  it('S4: 选中文本含 markdown 特殊字符加粗 → 内容正确且选区不错位', async () => {
    const s4 = await boot('plain a*b text\n\nsecond para here\n', { mode: 'ir' });
    try {
      const p = paras(s4)[0];
      assert.ok(selectTextIn(s4, p, 'a*b'), '前置：应能选中 a*b 子串');

      fireKey(s4, 'b');
      await settle();

      // 内容语义必须正确（a*b 的单个 * 不构成标记，加粗后语义不变）
      assert.match(s4.window.vditor.getValue(), /\*\*a\*b\*\*/);
      const sel = selOf(s4);
      assert.ok(sel.rangeCount > 0, '选区不应消失');
      // spin 未改变文本长度时精确恢复；文本被改写时校验兜底退化为塌缩，
      // 两者都不得选中错位内容
      if (!sel.isCollapsed) {
        assert.equal(selText(s4), 'a*b', '非塌缩时选区必须覆盖原文本');
      } else {
        assert.ok(resetEl(s4).contains(sel.getRangeAt(0).startContainer), '兜底光标应在编辑器内');
      }
    } finally {
      s4.window.close();
    }
  });
});

// ── L：IR 块级（列表/引用）选区保留 ──────────────────────────────────────

describe('style-selection: IR block styles keep selection (L)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  let ctx;
  before(async () => {
    ctx = await boot(MD, { mode: 'ir' });
  });

  it('L1: 选中子串转无序列表 → 列表生效且选区保留', async () => {
    const p = paras(ctx)[0];
    assert.ok(selectTextIn(ctx, p, 'first para'));

    clickToolbar(ctx, 'list');
    await settle();

    assert.ok(resetEl(ctx).querySelector('ul'), '应生成无序列表');
    assert.match(ctx.window.vditor.getValue(), /^[-*] first para words$/m);
    assert.equal(selOf(ctx).isCollapsed, false, '转列表后选区不应塌缩');
    assert.equal(selText(ctx), 'first para', '选中文本不应漂移');
  });

  it('L2: 选中子串转引用 → 引用生效且选区保留', async () => {
    const li = resetEl(ctx).querySelector('ul li') || paras(ctx)[0];
    assert.ok(selectTextIn(ctx, li, 'first para'));

    fireKey(ctx, ';');
    await settle();

    assert.ok(resetEl(ctx).querySelector('blockquote'), '应生成引用');
    assert.equal(selOf(ctx).isCollapsed, false, '转引用后选区不应塌缩');
    assert.equal(selText(ctx), 'first para', '选中文本不应漂移');
  });

  it('L3: 引用添加后再切换取消 → 选区保留（移除方向）', async () => {
    const l3 = await boot(MD, { mode: 'ir' });
    try {
      const p = paras(l3)[0];
      assert.ok(selectTextIn(l3, p, 'first para'));

      // 第一次：添加引用
      fireKey(l3, ';');
      await settle();
      assert.ok(resetEl(l3).querySelector('blockquote'), '前置：引用已生成');

      // 第二次：quote 按钮已 current，走移除分支
      const bq = resetEl(l3).querySelector('blockquote p, blockquote');
      assert.ok(selectTextIn(l3, bq, 'first para'));
      fireKey(l3, ';');
      await settle();

      assert.equal(resetEl(l3).querySelectorAll('blockquote').length, 0, '引用应被取消');
      assert.equal(selOf(l3).isCollapsed, false, '取消引用后选区不应塌缩');
      assert.equal(selText(l3), 'first para', '选中文本不应漂移');
    } finally {
      l3.window.close();
    }
  });
});

// ── W：WYSIWYG 块级（列表/引用）选区保留 ────────────────────────────────

describe('style-selection: WYSIWYG block styles keep selection (W)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  let ctx;
  before(async () => {
    ctx = await boot(MD, { mode: 'wysiwyg' });
  });

  it('W1: 块内子串选中转列表（单块路径）→ 选区保留', async () => {
    const p = paras(ctx)[0];
    assert.ok(selectTextIn(ctx, p, 'first para'));

    fireKey(ctx, 'o', { shiftKey: true });
    await settle();

    assert.ok(resetEl(ctx).querySelector('ul'), '应生成无序列表');
    assert.equal(selOf(ctx).isCollapsed, false, '转列表后选区不应塌缩');
    assert.equal(selText(ctx), 'first para', '选中文本不应漂移');
  });

  it('W2: 跨块选中转列表（批量路径）→ 选区保留且覆盖两块文本', async () => {
    const wctx = await boot(MD, { mode: 'wysiwyg' });
    try {
      const blocks = paras(wctx);
      assert.ok(selectTextIn(wctx, blocks[0], 'first para words'));
      // 扩展终点到第二块文本末尾
      const endNode = deepestFirstChild(blocks[1]);
      const sel = wctx.window.getSelection();
      const range = sel.getRangeAt(0);
      range.setEnd(endNode, endNode.textContent.length);
      sel.removeAllRanges();
      sel.addRange(range);
      wctx.document.dispatchEvent(new wctx.window.Event('selectionchange'));

      clickToolbar(wctx, 'list');
      await settle();

      const ul = resetEl(wctx).querySelector('ul');
      assert.ok(ul, '应生成列表');
      assert.equal(ul.querySelectorAll(':scope > li').length, 2, '两块都应转换');
      assert.equal(selOf(wctx).isCollapsed, false, '批量转换后选区不应塌缩');
      assert.equal(selText(wctx).replace(/\n/g, ''), 'first para wordssecond para here', '选区应覆盖两块文本');
    } finally {
      wctx.window.close();
    }
  });

  it('W3: 选中子串转引用 → 引用生效且选区保留', async () => {
    const qctx = await boot(MD, { mode: 'wysiwyg' });
    try {
      const p = paras(qctx)[0];
      assert.ok(selectTextIn(qctx, p, 'first para'));

      fireKey(qctx, ';');
      await settle();

      assert.ok(resetEl(qctx).querySelector('blockquote'), '应生成引用');
      assert.equal(selOf(qctx).isCollapsed, false, '转引用后选区不应塌缩');
      assert.equal(selText(qctx), 'first para', '选中文本不应漂移');
    } finally {
      qctx.window.close();
    }
  });

  it('W4: 光标塌缩时转列表 → 维持既有塌缩行为（回归保护）', async () => {
    const p = paras(ctx)[0];
    setCaretIn(ctx, p, 6);

    fireKey(ctx, 'o', { shiftKey: true });
    await settle();

    assert.ok(resetEl(ctx).querySelector('ul li'), '塌缩光标也应转列表');
    assert.equal(selOf(ctx).isCollapsed, true, '塌缩光标操作后应保持塌缩');
  });

  it('W5: 跨块选中已是列表的两块再切换 → 批量取消回段落且选区保留', async () => {
    const w5 = await boot(MD, { mode: 'wysiwyg' });
    try {
      // 先把两段批量转成列表
      let blocks = paras(w5);
      assert.ok(selectTextIn(w5, blocks[0], 'first para words'));
      const endNode0 = deepestFirstChild(blocks[1]);
      const sel0 = w5.window.getSelection();
      const range0 = sel0.getRangeAt(0);
      range0.setEnd(endNode0, endNode0.textContent.length);
      sel0.removeAllRanges();
      sel0.addRange(range0);
      w5.document.dispatchEvent(new w5.window.Event('selectionchange'));
      clickToolbar(w5, 'list');
      await settle();
      assert.ok(resetEl(w5).querySelector('ul'), '前置：两段已转列表');

      // 再跨选两个 li 取消列表（batchToggleList 走 unwrap 分支）
      const lis = resetEl(w5).querySelectorAll('ul > li');
      assert.equal(lis.length, 2, '前置：两个列表项');
      assert.ok(selectTextIn(w5, lis[0], 'first para words'));
      const sel = w5.window.getSelection();
      const range = sel.getRangeAt(0);
      const endNode = deepestFirstChild(lis[1]);
      range.setEnd(endNode, endNode.textContent.length);
      sel.removeAllRanges();
      sel.addRange(range);
      w5.document.dispatchEvent(new w5.window.Event('selectionchange'));

      clickToolbar(w5, 'list');
      await settle();

      assert.equal(resetEl(w5).querySelectorAll('ul').length, 0, '列表应被批量取消');
      assert.equal(selOf(w5).isCollapsed, false, '批量取消后选区不应塌缩');
      assert.equal(selText(w5).replace(/\n/g, ''), 'first para wordssecond para here', '选区应覆盖两块文本');
    } finally {
      w5.window.close();
    }
  });

  it('C1: 任务列表转换在内容前插入空格 → 选区按 +1 平移保持同文', async () => {
    const cctx = await boot(MD, { mode: 'wysiwyg' });
    try {
      const p = paras(cctx)[0];
      assert.ok(selectTextIn(cctx, p, 'first para'));

      clickToolbar(cctx, 'check');
      await settle();

      const li = resetEl(cctx).querySelector('ul li.vditor-task');
      assert.ok(li, '应生成任务列表项');
      assert.ok(li.querySelector('input[type="checkbox"]'), 'li 应含 checkbox');
      assert.equal(selOf(cctx).isCollapsed, false, '转任务列表后选区不应塌缩');
      assert.equal(selText(cctx), 'first para', '空格插入后选中文本不应漂移');
    } finally {
      cctx.window.close();
    }
  });

  it('C2: 无序列表切换为任务列表 → 保留原文本选区', async () => {
    const c2 = await boot(MD, { mode: 'wysiwyg' });
    try {
      const p = paras(c2)[0];
      // 光标落在偏移 0：转列表时 wbr 插在文本开头，不会切分文本节点
      // （偏移 >0 时 insertNode 会把文本切成两段，后续子串定位需跨节点）
      setCaretIn(c2, p, 0);
      clickToolbar(c2, 'list');
      await settle();
      assert.ok(resetEl(c2).querySelector('ul'), '前置：已转无序列表');

      const li = resetEl(c2).querySelector('ul li');
      assert.ok(li, '前置：列表项应存在');
      // 直设 li 首文本节点上的子串选区（不走 walker）
      const { window: c2w, document: c2d } = c2;
      const textNode = deepestFirstChild(li);
      const selRange = c2d.createRange();
      selRange.setStart(textNode, 0);
      selRange.setEnd(textNode, 'first para'.length);
      const c2sel = c2w.getSelection();
      c2sel.removeAllRanges();
      c2sel.addRange(selRange);
      c2d.dispatchEvent(new c2w.Event('selectionchange'));
      assert.equal(c2sel.toString(), 'first para', '前置：选区应覆盖 first para');
      clickToolbar(c2, 'check');
      await settle();

      const taskLi = resetEl(c2).querySelector('ul li.vditor-task');
      assert.ok(taskLi, '应切换为任务列表');
      assert.equal(selOf(c2).isCollapsed, false, '切换为任务列表后选区不应塌缩');
      assert.equal(selText(c2), 'first para', '选区必须覆盖原文本');
    } finally {
      c2.window.close();
    }
  });
});

// ── U：undo 与重建选区兼容 ───────────────────────────────────────────────

describe('style-selection: undo compatible with restored selection (U, ir)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  it('U1: IR 加粗 → undo 恢复原文本且光标落在编辑器内', async () => {
    const ctx = await boot(MD, { mode: 'ir' });
    try {
      const p = paras(ctx)[0];
      assert.ok(selectTextIn(ctx, p, 'first para'));

      fireKey(ctx, 'b');
      await settle();
      // undo 快照经 undoDelay(600ms) debounce 落栈，等待其稳定
      await sleep(800);

      ctx.window.vditor.vditor.undo.undo(ctx.window.vditor.vditor);
      await sleep(300);

      assert.equal(ctx.window.vditor.getValue().trim(), MD.trim(), 'undo 应恢复原文');
      const sel = selOf(ctx);
      assert.ok(sel.rangeCount > 0, 'undo 后应有选区/光标');
      assert.ok(resetEl(ctx).contains(sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null)
        || sel.isCollapsed, '光标应留在编辑器内');
    } finally {
      ctx.window.close();
    }
  });
});
