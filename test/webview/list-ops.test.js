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
async function boot(content, { mode = 'wysiwyg', liveMarkers = false } = {}) {
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
      if (liveMarkers) {
        window.eval(fs.readFileSync(path.join(ROOT, 'resource/markdown/list-marker.js'), 'utf8'));
        window.ListMarkerLive.install(window.vditor);
      }
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
      // 每项携带实际显示编号，与 Lute 解析得到的列表 DOM 一致。
      assert.match(md, /^1\. first para$/m);
      assert.match(md, /^2\. second para$/m);
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

// ── G：幂等取消与边界端点归属（#10） ────────────────────────────────────
// 两层根因的红测试：选区快照 start 端点边界前归属漂移（恢复后 start 落进
// 前一块，二次触发被批量分支解析为跨块选区）+ batchToggleList 对端点恰在
// 块边界的浏览器等价位置表达不收缩（零交集相邻块被卷入批量转换）

describe('list-ops: idempotent cancel & boundary endpoints (G, #10)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  const MD_IDEM = 'pre\n\none\n\ntwo\n';

  it('G1: wysiwyg 两段设列表后再次触发 → 幂等取消，前段不被吸并', async () => {
    const t = await boot(MD_IDEM);
    try {
      const blocks = paras(t);
      assert.equal(blocks.length, 3, '前置：pre + one + two 三段');
      selectFromTo(t, blocks[1], blocks[2]);
      clickToolbar(t, 'list');
      await settle();

      let ul = resetEl(t).querySelector('ul');
      assert.ok(ul, '第一次触发应生成列表');
      assert.equal(ul.querySelectorAll(':scope > li').length, 2);

      // 第二次触发：选区经第一次操作的快照恢复，start 端点不得漂移进 pre
      clickToolbar(t, 'list');
      await settle();

      const reset = resetEl(t);
      assert.equal(reset.querySelectorAll('ul').length, 0, '应幂等取消回段落');
      const ps = Array.from(reset.querySelectorAll('p[data-block="0"]'))
        .map((p) => p.textContent.trim());
      assert.deepEqual(ps, ['pre', 'one', 'two'], 'pre 保持段落，不被吸并');
    } finally {
      t.window.close();
    }
  });

  it('G2: 有序列表同场景幂等取消（ordered-list 按钮路径）', async () => {
    const t = await boot(MD_IDEM);
    try {
      const blocks = paras(t);
      selectFromTo(t, blocks[1], blocks[2]);
      clickToolbar(t, 'ordered-list');
      await settle();
      assert.ok(resetEl(t).querySelector('ol'), '第一次触发应生成有序列表');

      clickToolbar(t, 'ordered-list');
      await settle();

      const reset = resetEl(t);
      assert.equal(reset.querySelectorAll('ol').length, 0, '应幂等取消回段落');
      const ps = Array.from(reset.querySelectorAll('p[data-block="0"]'))
        .map((p) => p.textContent.trim());
      assert.deepEqual(ps, ['pre', 'one', 'two']);
    } finally {
      t.window.close();
    }
  });

  it('G3: start 端点表达在前块末尾（浏览器等价位置）→ 前块不被卷入', async () => {
    const t = await boot(MD_IDEM);
    try {
      const [pre, one, two] = paras(t);
      const { window, document } = t;
      const sel = window.getSelection();
      const range = document.createRange();
      // 与 setStart(one 文本, 0) 视觉等价：前块文本末尾
      range.setStart(deepestFirstChild(pre), pre.textContent.length);
      range.setEnd(deepestFirstChild(two), two.textContent.length);
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new window.Event('selectionchange'));

      clickToolbar(t, 'list');
      await settle();

      const reset = resetEl(t);
      const ps = Array.from(reset.querySelectorAll('p[data-block="0"]'))
        .map((p) => p.textContent.trim());
      assert.deepEqual(ps, ['pre'], 'pre 与选区零交集，保持段落');
      const ul = reset.querySelector('ul');
      assert.ok(ul, 'one/two 应转列表');
      assert.equal(ul.querySelectorAll(':scope > li').length, 2);
    } finally {
      t.window.close();
    }
  });

  it('G4: end 端点表达在后块绝对起点 → 按"选入该块"处理（语义记录）', async () => {
    // 端点 ≡ 后块绝对起点（(block,0) 的等价位置）有多种等价 Range 表达
    // （首文本@0 / 块内首个子元素@0）。既有批量契约（T6 等）的选区辅助
    // 会把 end 深入到目标块内部（首文本节点末尾），G4 自身则表达在
    // post 首文本@0——这些表达在视觉上都是"选入该块"，DOM 位置上与
    // 块起点不可区分——统一按"选入"处理，不做对称回退（#10 只修
    // start 侧漂移：end 前归属本就是正确语义，恢复的选区不会向后漂）。
    // 此用例固化该决策：end 在 post 开头 → post 被卷入批量转换，
    // 与 T6 行为一致
    const t = await boot('one\n\ntwo\n\npost\n');
    try {
      const [one, two, post] = paras(t);
      const { window, document } = t;
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(deepestFirstChild(one), 0);
      range.setEnd(deepestFirstChild(post), 0);
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new window.Event('selectionchange'));

      clickToolbar(t, 'list');
      await settle();

      const reset = resetEl(t);
      const ul = reset.querySelector('ul');
      assert.ok(ul, '应生成列表（三块全部卷入）');
      assert.equal(ul.querySelectorAll(':scope > li').length, 3);
    } finally {
      t.window.close();
    }
  });

  it('G6: start 零交集且推进后等价单块 → 转换用户实际选中的下一块（F1）', async () => {
    // 审查发现 F1：start 端点表达在前块末尾（零交集）、end 在紧邻下一块
    // 内部时，批量分支推进 startIndex 后塌缩为单块返回 false——单块路径
    // 的 blockElement/itemElement 解析锚定 range.startContainer，若 range
    // 未同步推进，会转换零交集的前块而非用户实际选中的下一块
    const t = await boot(MD_IDEM);
    try {
      const [pre, one, two] = paras(t);
      const { window, document } = t;
      const sel = window.getSelection();
      const range = document.createRange();
      // start 表达在 pre 文本末尾（与 one 开头视觉等价），end 在 one 内部
      range.setStart(deepestFirstChild(pre), pre.textContent.length);
      range.setEnd(deepestFirstChild(one), 2);
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new window.Event('selectionchange'));

      clickToolbar(t, 'list');
      await settle();

      const reset = resetEl(t);
      const ps = Array.from(reset.querySelectorAll('p[data-block="0"]'))
        .map((p) => p.textContent.trim());
      assert.deepEqual(ps, ['pre', 'two'], 'pre 零交集不转换，two 未选中不动');
      const ul = reset.querySelector('ul');
      assert.ok(ul, 'one（用户实际选中的块）应转列表');
      assert.equal(ul.querySelectorAll(':scope > li').length, 1);
      assert.match(ul.querySelector('li').textContent, /one/);
    } finally {
      t.window.close();
    }
  });

  it('G7: start 零交集且推进后目标为列表块 → 走列表切换而非嵌套包裹（N3）', async () => {
    // 审查终检发现 N3：零交集推进塌缩为单块后，单块路径的 itemElement
    // 取自推进前的锚点（恒 null），添加分支会把整个既有列表块包进新 li
    // 产生嵌套结构破坏（不增删文本，restore 校验静默放行）
    const t = await boot('pre\n\n- one\n- two\n');
    try {
      const reset = resetEl(t);
      const pre = paras(t)[0];
      const ul = reset.querySelector('ul');
      const { window, document } = t;
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(deepestFirstChild(pre), pre.textContent.length);
      range.setEnd(deepestFirstChild(ul.querySelector('li')), 2);
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new window.Event('selectionchange'));

      clickToolbar(t, 'ordered-list');
      await settle();

      const r2 = resetEl(t);
      assert.equal(r2.querySelectorAll('ul ol, ol ul, ul ul, ol ol').length, 0,
        '不得嵌套包裹既有列表');
      const ol = r2.querySelector('ol');
      assert.ok(ol, '应按切换语义处理（无序 → 有序）');
      assert.equal(ol.querySelectorAll(':scope > li').length, 2);
      const md = t.window.vditor.getValue();
      assert.match(md, /1\. one/, JSON.stringify(md));
      assert.ok(Array.from(r2.querySelectorAll('p[data-block="0"]'))
        .some((p) => p.textContent.trim() === 'pre'), '零交集的 pre 保持段落');
    } finally {
      t.window.close();
    }
  });

  it('G8: start 零交集塌缩目标为结构块（表格）→ 不转换不破坏（R1）', async () => {
    // 终检 R1：N3 同族的窄触发残留——零交集推进塌缩后锚点落入结构块
    // 时，添加分支不得把 table.innerHTML 包进 li；对齐批量分支对结构块
    // "原样保留"的契约
    const t = await boot('pre\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    try {
      const reset = resetEl(t);
      const pre = paras(t)[0];
      const table = reset.querySelector('table');
      const { window, document } = t;
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(deepestFirstChild(pre), pre.textContent.length);
      range.setEnd(deepestFirstChild(table.querySelector('td')), 1);
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new window.Event('selectionchange'));

      clickToolbar(t, 'list');
      await settle();

      const r2 = resetEl(t);
      assert.equal(r2.querySelectorAll('table').length, 1, '表格保留');
      assert.equal(r2.querySelectorAll('ul, ol').length, 0, '不产生列表');
      assert.ok(Array.from(r2.querySelectorAll('p[data-block="0"]'))
        .some((p) => p.textContent.trim() === 'pre'), 'pre 保持段落');
    } finally {
      t.window.close();
    }
  });

  it('G5: ir 模式两段设列表后再次触发 → 幂等取消，前段不被吸并', async () => {
    const t = await boot(MD_IDEM, { mode: 'ir' });
    try {
      const blocks = paras(t);
      selectFromTo(t, blocks[1], blocks[2]);
      clickToolbar(t, 'list');
      await settle();
      assert.ok(resetEl(t).querySelector('ul'), 'ir 第一次触发应生成列表');

      clickToolbar(t, 'list');
      await settle();

      const reset = resetEl(t);
      assert.equal(reset.querySelectorAll('ul').length, 0, 'ir 应幂等取消回段落');
      const ps = Array.from(reset.querySelectorAll('p[data-block="0"]'))
        .map((p) => p.textContent.trim());
      assert.deepEqual(ps, ['pre', 'one', 'two'], 'ir 前段不被吸并');
    } finally {
      t.window.close();
    }
  });
});

// ── N/H/Q/R：审查补强（嵌套子列表 / heading / 单列表回退 / 引用隔断） ────

describe('list-ops: review hardening (N/H/Q/R)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {
  for (const mode of ['ir', 'wysiwyg']) {
    for (const [label, source, expected] of [
      ['顶层首项', '123. 三 agent\n124. next\n', '三 agent\n\n124. next\n'],
      ['唯一子项', '1. parent\n   - 三 agent\n', '1. parent\n\n   三 agent\n'],
      ['中间子项', '1. parent\n   - before\n   - 三 agent\n   - after\n2. sibling\n',
        '1. parent\n\n   - before\n\n   三 agent\n\n   - after\n2. sibling\n'],
    ]) {
      for (const entry of ['content', 'marker-cleared']) {
        it(`N4: ${mode} ${label}退格取消标记且保留顺序，${entry}`, async () => {
          const t = await boot(source, { mode, liveMarkers: true });
          try {
            const reset = resetEl(t);
            const item = Array.from(reset.querySelectorAll('li')).find(el => el.textContent === '三 agent');
            selectFromTo(t, item, item);
            t.window.getSelection().collapseToStart();
            t.document.dispatchEvent(new t.window.Event('selectionchange'));
            if (entry === 'marker-cleared') {
              const marker = item.querySelector('.vmd-li-marker');
              marker.textContent = '';
              const range = t.document.createRange();
              range.setStart(marker, 0); range.collapse(true);
              t.window.getSelection().removeAllRanges();
              t.window.getSelection().addRange(range);
            }
            fireKey(t, 'Backspace');
            await settle();
            assert.equal(t.window.vditor.getValue(), expected);
            t.window.vditor.setValue(t.window.vditor.getValue());
            assert.equal(t.window.vditor.getValue(), expected, '重开后层级和顺序保持');
          } finally { t.window.close(); }
        });
      }
    }
    for (const liveMarkers of [false, true]) {
      it(`N3: ${mode} 取消二级列表保留独立段落，liveMarkers=${liveMarkers}`, async () => {
        const t = await boot('1. parent\n   - 三 agent\n', { mode, liveMarkers });
        try {
          const reset = resetEl(t);
          const child = reset.querySelector('li li');
          selectFromTo(t, child, child);
          t.window.getSelection().collapseToEnd();
          t.document.dispatchEvent(new t.window.Event('selectionchange'));
          if (liveMarkers) assert.ok(child.querySelector('.vmd-li-marker'));
          child.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
          assert.ok(t.window.vditor.vditor.toolbar.elements.list.children[0].classList.contains('vditor-menu--current'));
          clickToolbar(t, 'list');
          await settle();
          assert.equal(t.window.vditor.getValue(), '1. parent\n\n   三 agent\n',
            '取消子列表后正文须为父项中的独立段落，不能吸入父项首段');
          assert.equal(reset.querySelectorAll('li li, p .vmd-li-marker').length, 0,
            '已取消的子项不能残留列表或临时标记');
          t.window.vditor.setValue(t.window.vditor.getValue());
          assert.equal(reset.querySelectorAll('ol > li > p').length, 2,
            '重新打开仍为父项中的两个段落');
        } finally { t.window.close(); }
      });
    }
  }

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
