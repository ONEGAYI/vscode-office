'use strict';

/**
 * Webview 集成测试 — 列表快捷键与多块批量列表（feat/list-ops）
 *
 * 覆盖两个特性：
 * - 无序列表工具栏快捷键 ⇧⌘O（Windows: Ctrl+Shift+O）
 * - 选区跨多个顶层块时批量应用 无序/有序/任务 列表（wysiwyg + ir 双模式，
 *   两模式共用 listToggle，此处双模式都驱动以防分发层回归）
 *
 * 驱动真实构建产物（vditor/dist）：
 * - 快捷键用例派发 keydown 到编辑面，走 hotkeyEvent → 工具栏分发全链
 * - 批量用例向工具栏按钮派发 CustomEvent('click')（与 hotkeyEvent
 *   分发器对 MenuItem 的触发方式一致），驱动 toolbarEvent/processToolbar
 *
 * 语义契约：
 * - 跨块批量切换（toggle）：选区整体已是目标列表 → 全部取消回段落；
 *   否则（无列表/异类型列表/混合）→ 全部转为目标列表，已有列表的 li
 *   吸并进相邻连续段合成同一列表；表格/引用等结构块原样保留并隔断分组
 * - 单块/单列表选中维持既有行为（回归保护）
 *
 * 前置：需先构建 vditor 子包（vditor/dist 不入库）。未构建时整组跳过。
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

const MD = '# Title\n\nfirst para\n\nsecond para\n\nthird para\n';
const MD_TABLE = 'first\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nsecond\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIST_READY = fs.existsSync(path.join(DIST, 'index.min.js'))
  && fs.existsSync(path.join(DIST, 'js', 'lute', 'lute.min.js'));

const fileUrl = (p) => 'file://' + p.replace(/\\/g, '/');

/** 以真实构建产物启动编辑器（照 list-marker.test.js 的 boot 模式） */
async function boot(content, { mode = 'wysiwyg' } = {}) {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => pageErrors.push(String(err)));

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: fileUrl(path.join(ROOT, '__list-ops-test__.html')),
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
    toolbar: ['list', 'ordered-list', 'check'],
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

/** 顶层段落块（p，不含标题/哨兵 span），按文档序 */
const paras = (ctx) => Array.from(resetEl(ctx).querySelectorAll('p[data-block="0"]'));

/** 深入到元素内首个文本节点（ir 的 h1 首子节点是 marker span 元素） */
function deepestFirstChild(el) {
  let node = el.firstChild || el;
  while (node && node.nodeType === 1 && node.firstChild) {
    node = node.firstChild;
  }
  return node;
}

/** 跨块选区：从 start 块文本开头选到 end 块文本末尾，并通知 selectionchange。
 *  jsdom 限制（25.x 实测）：startContainer 为元素节点 offset 0 时
 *  range.insertNode(wbr)（listToggle 入口）会错误重定位 endContainer，
 *  使批量分支静默退回单块路径——起点/终点均深入到首个文本节点 */
function selectFromTo(ctx, startEl, endEl) {
  const { window, document } = ctx;
  const startNode = deepestFirstChild(startEl);
  const endNode = deepestFirstChild(endEl);
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(startNode, 0);
  range.setEnd(endNode, endNode.textContent.length);
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new window.Event('selectionchange'));
}

const selectBlocks = (ctx, startBlock, endBlock) => selectFromTo(ctx, startBlock, endBlock);

/** 与 hotkeyEvent 分发器同款：向 MenuItem 内部按钮派发 click CustomEvent */
function clickToolbar(ctx, name) {
  const btn = ctx.window.vditor.vditor.toolbar.elements[name].children[0];
  btn.dispatchEvent(new ctx.window.CustomEvent('click'));
}

/** 派发编辑键（hotkeyEvent 绑定在编辑面上） */
function fireKey(ctx, key, opts = {}) {
  resetEl(ctx).dispatchEvent(new ctx.window.KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, ...opts,
  }));
}

const settle = () => sleep(120);

// ── K：无序列表快捷键 ⇧⌘O ───────────────────────────────────────────────

describe('list-ops: unordered list hotkey (K)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  let ctx;
  before(async () => {
    ctx = await boot(MD);
  });

  it('K1: 默认工具栏 list 项带 hotkey ⇧⌘O', () => {
    const item = ctx.window.vditor.vditor.options.toolbar
      .filter((t) => typeof t === 'object')
      .find((t) => t.name === 'list');
    assert.ok(item, 'toolbar 中应有 list 项');
    assert.equal(item.hotkey, '⇧⌘O');
  });

  it('K2: Ctrl+Shift+O 把光标所在段落转为无序列表', async () => {
    const blocks = paras(ctx);
    const { window, document } = ctx;
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(blocks[0].firstChild, 5);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new window.Event('selectionchange'));

    fireKey(ctx, 'o', { ctrlKey: true, shiftKey: true });
    await settle();

    const ul = resetEl(ctx).querySelector('ul');
    assert.ok(ul, '应生成无序列表');
    const li = ul.querySelector('li');
    assert.match(li.textContent, /first para/);
    assert.equal(resetEl(ctx).querySelectorAll('p[data-block="0"]').length,
      MD.split('\n').filter((l) => l && !l.startsWith('#')).length - 1,
      '其余段落保持不变');
    assert.match(ctx.window.vditor.getValue(), /^[-*] first para/m);
  });
});

// ── B：多块批量列表（wysiwyg） ──────────────────────────────────────────

describe('list-ops: batch list over multi-block selection (B, wysiwyg)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  let ctx;
  before(async () => {
    ctx = await boot(MD);
  });

  it('B1: 选中两段应用无序列表 → 同一 ul 的两个 li，getValue 输出列表', async () => {
    const blocks = paras(ctx);
    selectBlocks(ctx, blocks[0], blocks[1]);
    clickToolbar(ctx, 'list');
    await settle();

    const uls = resetEl(ctx).querySelectorAll('ul');
    assert.equal(uls.length, 1, '连续两段应并入同一个列表');
    const lis = uls[0].querySelectorAll(':scope > li');
    assert.equal(lis.length, 2);
    assert.match(lis[0].textContent, /first para/);
    assert.match(lis[1].textContent, /second para/);
    const md = ctx.window.vditor.getValue();
    assert.match(md, /^[-*] first para$/m);
    assert.match(md, /^[-*] second para$/m);
  });

  it('B2: 选中两段应用有序列表 → 同一 ol 的两个 li', async () => {
    const olCtx = await boot(MD);
    try {
      const blocks = paras(olCtx);
      selectBlocks(olCtx, blocks[0], blocks[1]);
      clickToolbar(olCtx, 'ordered-list');
      await settle();

      const ols = resetEl(olCtx).querySelectorAll('ol');
      assert.equal(ols.length, 1);
      const lis = ols[0].querySelectorAll(':scope > li');
      assert.equal(lis.length, 2);
      const md = olCtx.window.vditor.getValue();
      // 与既有"ul→ol 切换"路径的序列化一致：所有 li 输出起始编号 1.
      // （CommonMark 合法，编号由 <ol> 渲染时自动生成）
      assert.match(md, /^1\. first para$/m);
      assert.match(md, /^1\. second para$/m);
    } finally {
      olCtx.window.close();
    }
  });

  it('B3: 选中两段应用任务列表 → li 带 checkbox', async () => {
    const checkCtx = await boot(MD);
    try {
      const blocks = paras(checkCtx);
      selectBlocks(checkCtx, blocks[0], blocks[1]);
      clickToolbar(checkCtx, 'check');
      await settle();

      const ul = resetEl(checkCtx).querySelector('ul');
      assert.ok(ul, '任务列表也是 ul');
      const lis = ul.querySelectorAll(':scope > li');
      assert.equal(lis.length, 2);
      lis.forEach((li) => {
        assert.ok(li.querySelector('input[type="checkbox"]'), '每个 li 应含 checkbox');
        assert.ok(li.classList.contains('vditor-task'));
      });
    } finally {
      checkCtx.window.close();
    }
  });

  it('B4: 选区含表格 → 表格原样保留，前后两段各自成列表', async () => {
    const tableCtx = await boot(MD_TABLE);
    try {
      const blocks = paras(tableCtx);
      assert.equal(blocks.length, 2, '前置：文档为 p + table + p');
      selectBlocks(tableCtx, blocks[0], blocks[1]);
      clickToolbar(tableCtx, 'list');
      await settle();

      const reset = resetEl(tableCtx);
      assert.equal(reset.querySelectorAll('table').length, 1, '表格保留');
      const uls = reset.querySelectorAll('ul');
      assert.equal(uls.length, 2, '被表格隔开的段落各自成列表');
      assert.match(uls[0].querySelector('li').textContent, /first/);
      assert.match(uls[1].querySelector('li').textContent, /second/);
    } finally {
      tableCtx.window.close();
    }
  });

  it('B5: 单块内选中（既有行为回归保护）→ 仅该块转单项列表', async () => {
    const singleCtx = await boot(MD);
    try {
      const blocks = paras(singleCtx);
      const { window, document } = singleCtx;
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(blocks[0].firstChild, 2);
      range.setEnd(blocks[0].firstChild, 6);
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new window.Event('selectionchange'));

      clickToolbar(singleCtx, 'list');
      await settle();

      const ul = resetEl(singleCtx).querySelector('ul');
      assert.ok(ul, '单块选中仍应转列表');
      assert.equal(ul.querySelectorAll(':scope > li').length, 1);
    } finally {
      singleCtx.window.close();
    }
  });

  it('B6: 选区起止于块中间文本 → 整块语义，两块都转换', async () => {
    const midCtx = await boot(MD);
    try {
      const blocks = paras(midCtx);
      const { window, document } = midCtx;
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(blocks[0].firstChild, 2);
      range.setEnd(blocks[1].firstChild, 4);
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new window.Event('selectionchange'));

      clickToolbar(midCtx, 'list');
      await settle();

      const ul = resetEl(midCtx).querySelector('ul');
      assert.ok(ul);
      assert.equal(ul.querySelectorAll(':scope > li').length, 2, '部分选中也按整块转换');
    } finally {
      midCtx.window.close();
    }
  });

  it('B7: 批量转换后 undo 恢复两个段落', async () => {
    const undoCtx = await boot(MD);
    try {
      // boot 的初始快照经 undoDelay(600ms) debounce 入栈；先等它落栈，
      // 否则转换快照与初始快照合并为一条，栈内仅 1 条时 undo 为 no-op
      await sleep(800);
      const blocks = paras(undoCtx);
      selectBlocks(undoCtx, blocks[0], blocks[1]);
      clickToolbar(undoCtx, 'list');
      // fork undoDelay 默认 600ms：等待转换后快照入栈（栈内 ≥2 条 undo 才回退）
      await sleep(800);
      assert.ok(resetEl(undoCtx).querySelector('ul'), '前置：批量转换已生效');

      // 直调 undo 栈（Ctrl+Z 在有 undo 工具栏按钮时被跳过，同 list-marker U 组）
      undoCtx.window.vditor.vditor.undo.undo(undoCtx.window.vditor.vditor);
      await settle();
      assert.equal(resetEl(undoCtx).querySelectorAll('ul').length, 0, 'undo 后列表应撤销');
      const md = undoCtx.window.vditor.getValue();
      assert.match(md, /^first para$/m);
      assert.match(md, /^second para$/m);
    } finally {
      undoCtx.window.close();
    }
  });
});

// ── T：批量切换语义（toggle） ────────────────────────────────────────────
// 选区整体已是目标列表 → 全部取消回段落；否则（无列表/异类型/混合）→
// 全部转为目标列表，已有列表的 li 吸并进来（相邻连续段合成同一列表）

describe('list-ops: batch toggle semantics (T)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  it('T1: 两个目标列表跨选 → 全部取消回段落', async () => {
    const t = await boot('- a\n- b\n\n* c\n* d\n');
    try {
      const reset = resetEl(t);
      const [ul1, ul2] = reset.querySelectorAll('ul');
      assert.equal(reset.querySelectorAll('ul').length, 2, '前置：异 marker 构成两个列表');
      selectFromTo(t, ul1.querySelector('li'), ul2.querySelector('li:last-child'));
      clickToolbar(t, 'list');
      await settle();

      assert.equal(reset.querySelectorAll('ul').length, 0, '两个列表都应取消');
      assert.equal(reset.querySelectorAll('p[data-block="0"]').length, 4, '每个 li 各回一个段落');
    } finally {
      t.window.close();
    }
  });

  it('T2: 有序列表 + 段落跨选 → 切换为无序列表（ol 的 li 吸并）', async () => {
    const t = await boot('1. one\n2. two\n\npara\n');
    try {
      const reset = resetEl(t);
      const ol = reset.querySelector('ol');
      const p = reset.querySelector('p[data-block="0"]');
      selectFromTo(t, ol.querySelector('li'), p);
      clickToolbar(t, 'list');
      await settle();

      assert.equal(reset.querySelectorAll('ol').length, 0, '有序列表应消失');
      const ul = reset.querySelector('ul');
      assert.ok(ul, '应生成无序列表');
      const texts = Array.from(ul.querySelectorAll(':scope > li')).map((li) => li.textContent);
      assert.deepEqual(texts.map((s) => s.replace(/\s+/g, ' ').trim()), ['one', 'two', 'para']);
      const md = t.window.vditor.getValue();
      assert.match(md, /^[-*] one$/m);
      assert.match(md, /^[-*] para$/m);
    } finally {
      t.window.close();
    }
  });

  it('T3: 段落+目标列表+段落 → 吸并为同一个列表', async () => {
    const t = await boot('first\n\n- mid\n\nlast\n');
    try {
      const reset = resetEl(t);
      const [p1, ul, p2] = [reset.querySelector('p[data-block="0"]'), reset.querySelector('ul'),
        reset.querySelectorAll('p[data-block="0"]')[1]];
      selectFromTo(t, p1, p2);
      clickToolbar(t, 'list');
      await settle();

      assert.equal(reset.querySelectorAll('ul').length, 1, '全部并入同一个列表');
      assert.equal(reset.querySelectorAll('ul > li').length, 3);
    } finally {
      t.window.close();
    }
  });

  it('T4: 两个目标列表夹表格跨选 → 取消列表且表格保留', async () => {
    const t = await boot('- a\n- b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n- c\n- d\n');
    try {
      const reset = resetEl(t);
      const [ul1, ul2] = reset.querySelectorAll('ul');
      selectFromTo(t, ul1.querySelector('li'), ul2.querySelector('li:last-child'));
      clickToolbar(t, 'list');
      await settle();

      assert.equal(reset.querySelectorAll('ul').length, 0, '两个列表都应取消');
      assert.equal(reset.querySelectorAll('table').length, 1, '表格保留');
      assert.equal(reset.querySelectorAll('p[data-block="0"]').length, 4);
    } finally {
      t.window.close();
    }
  });

  it('T5: 任务列表 + 段落跨选 → 切换为普通无序列表（去掉 checkbox）', async () => {
    const t = await boot('- [ ] one\n- [x] two\n\npara\n');
    try {
      const reset = resetEl(t);
      const ul = reset.querySelector('ul');
      const p = reset.querySelector('p[data-block="0"]');
      selectFromTo(t, ul.querySelector('li'), p);
      clickToolbar(t, 'list');
      await settle();

      const newUl = reset.querySelector('ul');
      assert.ok(newUl);
      assert.equal(newUl.querySelectorAll('input').length, 0, 'checkbox 应全部移除');
      assert.equal(newUl.querySelectorAll(':scope > li').length, 3);
      const md = t.window.vditor.getValue();
      assert.ok(!md.includes('['), '任务标记不应残留在源码: ' + JSON.stringify(md));
    } finally {
      t.window.close();
    }
  });

  it('T6: 段落 + 任务列表跨选 → 切换为任务列表（段落补 checkbox）', async () => {
    const t = await boot('todo\n\n- [x] done\n');
    try {
      const reset = resetEl(t);
      const p = reset.querySelector('p[data-block="0"]');
      const ul = reset.querySelector('ul');
      selectFromTo(t, p, ul.querySelector('li'));
      clickToolbar(t, 'check');
      await settle();

      const newUl = reset.querySelector('ul');
      assert.ok(newUl);
      const lis = newUl.querySelectorAll(':scope > li');
      assert.equal(lis.length, 2);
      lis.forEach((li) => {
        assert.ok(li.querySelector('input[type="checkbox"]'), '每个 li 应含 checkbox');
        assert.ok(li.classList.contains('vditor-task'));
      });
      const md = t.window.vditor.getValue();
      assert.match(md, /^[-*] \[ \] todo$/m);
      // Lute 序列化已勾选项为大写 X
      assert.match(md, /^[-*] \[[xX]\] done$/m);
    } finally {
      t.window.close();
    }
  });

  it('T7: 批量选区经 Ctrl+Shift+O 快捷键转换（快捷键路径的批量分支）', async () => {
    const t = await boot(MD);
    try {
      const blocks = paras(t);
      selectFromTo(t, blocks[0], blocks[1]);
      fireKey(t, 'o', { ctrlKey: true, shiftKey: true });
      await settle();

      const ul = resetEl(t).querySelector('ul');
      assert.ok(ul, '快捷键应触发批量转换');
      assert.equal(ul.querySelectorAll(':scope > li').length, 2);
    } finally {
      t.window.close();
    }
  });
});

// ── I：多块批量列表（ir 模式） ──────────────────────────────────────────

describe('list-ops: batch list in ir mode (I)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  let ctx;
  before(async () => {
    ctx = await boot(MD, { mode: 'ir' });
  });

  it('I1: ir 模式选中两段应用无序列表 → 同一 ul 的两个 li', async () => {
    const blocks = paras(ctx);
    selectBlocks(ctx, blocks[0], blocks[1]);
    clickToolbar(ctx, 'list');
    await settle();

    const ul = resetEl(ctx).querySelector('ul');
    assert.ok(ul, 'ir 模式也应生成列表');
    const lis = ul.querySelectorAll(':scope > li');
    assert.equal(lis.length, 2);
    const md = ctx.window.vditor.getValue();
    assert.match(md, /^[-*] first para$/m);
    assert.match(md, /^[-*] second para$/m);
  });
});

// ── N/H/Q/R：审查补强（嵌套子列表 / heading / 单列表回退 / 引用隔断） ────

describe('list-ops: review hardening (N/H/Q/R)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  it('N1: 转换为普通列表时嵌套子列表的 checkbox 保留', async () => {
    const t = await boot('- a\n  - [ ] b\n\npara\n');
    try {
      const reset = resetEl(t);
      const ul = reset.querySelector('ul');
      const p = reset.querySelector('p[data-block="0"]');
      selectFromTo(t, ul.querySelector('li'), p);
      clickToolbar(t, 'list');
      await settle();

      const newUl = reset.querySelector('ul');
      const topLis = newUl.querySelectorAll(':scope > li');
      assert.equal(topLis.length, 2, '顶层 li：a 与 para');
      assert.equal(newUl.querySelectorAll(':scope > li > input').length, 0,
        '顶层 li 不应有 checkbox');
      const nested = newUl.querySelector('ul li ul li');
      assert.ok(nested, '嵌套子列表应保留');
      assert.ok(nested.querySelector(':scope > input'), '嵌套 li 的 checkbox 不应被误删');
      const md = t.window.vditor.getValue();
      assert.match(md, /- \[ \] b/, '任务标记应保留在源码');
    } finally {
      t.window.close();
    }
  });

  it('N2: 取消含嵌套子列表的目标列表 → 子列表提升、无空段落残留', async () => {
    const t = await boot('- a\n  - a1\n\n* b\n');
    try {
      const reset = resetEl(t);
      // 只取编辑面直接子级的列表（嵌套子列表也是 ul，后代查询会错位）
      const topUls = Array.from(reset.children).filter((el) => el.tagName === 'UL');
      assert.equal(topUls.length, 2, '前置：两个顶层列表');
      selectFromTo(t, topUls[0].querySelector('li'), topUls[1].querySelector('li'));
      clickToolbar(t, 'list');
      await settle();

      const md = t.window.vditor.getValue();
      assert.ok(!md.includes('\n\n\n'), '不应产生三连空行: ' + JSON.stringify(md));
      assert.match(md, /^a$/m, '顶层项回段落');
      assert.match(md, /^- a1$/m, '嵌套子列表提升为顶层');
      assert.match(md, /^b$/m, '另一列表项回段落');
      const emptyP = Array.from(reset.querySelectorAll('p')).filter(
        (el) => !el.textContent.trim());
      assert.equal(emptyP.length, 0, '不应有空段落残留');
    } finally {
      t.window.close();
    }
  });

  it('H1: wysiwyg 模式 heading 参与批量转换', async () => {
    const t = await boot('# Head\n\nbody\n', { mode: 'wysiwyg' });
    try {
      const reset = resetEl(t);
      selectFromTo(t, reset.querySelector('h1'), reset.querySelector('p[data-block="0"]'));
      clickToolbar(t, 'list');
      await settle();

      const ul = reset.querySelector('ul');
      assert.ok(ul);
      assert.equal(ul.querySelectorAll(':scope > li').length, 2);
      const md = t.window.vditor.getValue();
      assert.match(md, /^[-*] Head$/m);
      assert.match(md, /^[-*] body$/m);
    } finally {
      t.window.close();
    }
  });

  it('H2: ir 模式 heading 参与批量转换（marker 不应残留在列表项内）', async () => {
    const t = await boot('# Head\n\nbody\n', { mode: 'ir' });
    try {
      const reset = resetEl(t);
      selectFromTo(t, reset.querySelector('h1'), reset.querySelector('p[data-block="0"]'));
      clickToolbar(t, 'list');
      await settle();

      const ul = reset.querySelector('ul');
      assert.ok(ul, 'ir 模式 heading+段落应转换');
      assert.equal(ul.querySelectorAll(':scope > li').length, 2, '两个块都应转换');
      const md = t.window.vditor.getValue();
      assert.match(md, /^[-*] Head$/m, 'heading 内容应干净进入列表项: ' + JSON.stringify(md));
      assert.match(md, /^[-*] body$/m);
    } finally {
      t.window.close();
    }
  });

  it('H3: ir 批量转换保留行内格式语法（marker 剔除仅限 heading）', async () => {
    const t = await boot('**bold** and `code` tail\n\npara\n', { mode: 'ir' });
    try {
      const reset = resetEl(t);
      const [p1, p2] = Array.from(reset.children).filter((el) => el.tagName === 'P');
      selectFromTo(t, p1, p2);
      clickToolbar(t, 'list');
      await settle();

      const md = t.window.vditor.getValue();
      assert.match(md, /\*\*bold\*\*/, '粗体语法不应丢失: ' + JSON.stringify(md));
      assert.match(md, /`code`/, '行内代码语法不应丢失');
      assert.match(md, /^[-*] para$/m);
    } finally {
      t.window.close();
    }
  });

  it('Q1: 单列表内选区 → 整列表切换（既有行为锁定）', async () => {
    const t = await boot('- a\n- b\n- c\n');
    try {
      const reset = resetEl(t);
      const ul = reset.querySelector('ul');
      selectFromTo(t, ul.querySelector('li'), ul.querySelector('li:last-child'));
      clickToolbar(t, 'ordered-list');
      await settle();

      assert.equal(reset.querySelectorAll('ul').length, 0, '整列表切换为有序');
      const ol = reset.querySelector('ol');
      assert.ok(ol);
      assert.equal(ol.querySelectorAll(':scope > li').length, 3, '整列表粒度，非仅选区 li');
    } finally {
      t.window.close();
    }
  });

  it('R1: 引用块隔断 → 引用保留、两段各自成列表', async () => {
    const t = await boot('p1\n\n> quote\n\np2\n');
    try {
      const reset = resetEl(t);
      // 只取编辑面直接子级的段落（blockquote 内也有 p[data-block]）
      const topParas = Array.from(reset.children).filter((el) => el.tagName === 'P');
      assert.equal(topParas.length, 2, '前置：p + blockquote + p');
      selectFromTo(t, topParas[0], topParas[1]);
      clickToolbar(t, 'list');
      await settle();

      assert.equal(reset.querySelectorAll('blockquote').length, 1, '引用块保留');
      const uls = reset.querySelectorAll('ul');
      assert.equal(uls.length, 2, '被引用隔开的段落各自成列表');
    } finally {
      t.window.close();
    }
  });
});
