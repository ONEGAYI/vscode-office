'use strict';

/**
 * Webview 集成测试 — 大纲拖拽重排与条目标式透传（feat/outline-drag-reorder）
 *
 * 覆盖两个特性（wysiwyg + ir 双模式）：
 * - 大纲行拖拽 → 治理区域整体移动，getValue() 源文本精确重排（不少移/不多移）、
 *   自嵌无效区拒绝、原位等价无操作、undo 一次恢复、options.input 保存链连通
 * - 大纲条目透传正文标题行内格式（strong/em/code/s，ir 含 <s> 丢失修复）与
 *   元素级 CSS 偏差快照注入（font-size 恒不透传）
 * - 审查轮补充：拖拽中途大纲重建（id 重编号）不漂移拖拽对象、外来拖放不触发
 *   重排（自定义 MIME 门）、直通内容单次转义与 on* 属性剥离、等价无操作保持
 *   保存链静默
 *
 * 驱动真实构建产物（vditor/dist）：合成 mousedown/dragstart/dragover/drop/dragend
 * 事件序列（jsdom 无 DragEvent 构造器，用 Event + dataTransfer stub；
 * 行矩形 stub 控制落点判定上半/下半区）。
 *
 * 前置：需先构建 vditor 子包（vditor/dist 不入库）。未构建时整组跳过。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { TextDecoder, TextEncoder } = require('node:util');
const { webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'vditor', 'dist');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(150);

const DIST_READY = fs.existsSync(path.join(DIST, 'index.min.js'))
  && fs.existsSync(path.join(DIST, 'js', 'lute', 'lute.min.js'));

const fileUrl = (p) => 'file://' + p.replace(/\\/g, '/');

// 文档结构：h1(Alpha)+p / h2(Alpha Sub)+p / h1(Beta)+p+p —— 大纲行序 [h1, h2, h1]
const MD_DND = [
  '# Alpha', '', 'alpha intro', '', '## Alpha Sub', '', 'sub body', '',
  '# Beta', '', 'beta one', '', 'beta two', '',
].join('\n');

const stripTailingNewlines = (s) => s.replace(/\n+$/, '');

/** 以真实构建产物启动编辑器（照 list-ops.test.js 的 boot 模式） */
async function boot(content, { mode = 'wysiwyg', inputs = null } = {}) {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => pageErrors.push(String(err)));

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: fileUrl(path.join(ROOT, '__outline-dnd-test__.html')),
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
    input: inputs ? (text) => inputs.push(text) : undefined,
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

/** 内部 IVditor（toolbar/undo/outline 实例挂载处） */
const inner = (ctx) => ctx.window.vditor.vditor;

/** 大纲面板内容行（span[data-target-id]，文档序扁平排列） */
const outlineRows = (ctx) => Array.from(
  inner(ctx).outline.element.querySelectorAll('span[data-target-id]'));

const contentSpanOf = (row) => row.lastElementChild;

const getMd = (ctx) => stripTailingNewlines(ctx.window.vditor.getValue());

// 大纲拖拽的自定义 MIME（dragReorder 以此识别本面板发起的拖拽）
const OUTLINE_DRAG_MIME = 'application/x-vditor-outline';

/** 合成拖拽事件（jsdom 无 DragEvent：Event + dataTransfer stub） */
function fireDragEvent(ctx, target, type, { clientY = 0, types = ['text/plain', OUTLINE_DRAG_MIME] } = {}) {
  const ev = new ctx.window.Event(type, { bubbles: true, cancelable: true });
  ev.dataTransfer = {
    setData() { },
    getData() { return ''; },
    types,
    effectAllowed: '',
    dropEffect: '',
  };
  ev.clientY = clientY;
  target.dispatchEvent(ev);
  return ev;
}

/**
 * 拖动第 fromIdx 行到第 toIdx 行的上方/下方并落点。
 * 矩形 stub：above → 高度 0（判定为上方）；below → clientY 落在下半区。
 */
function dragRowTo(ctx, fromIdx, toIdx, position) {
  const rows = outlineRows(ctx);
  assert.ok(rows.length > Math.max(fromIdx, toIdx), `前置：大纲应有足够行，实际 ${rows.length}`);
  const from = rows[fromIdx];
  const to = rows[toIdx];
  const rect = position === 'below'
    ? { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }
    : { top: 0, left: 0, right: 100, bottom: 0, width: 100, height: 0 };
  to.getBoundingClientRect = () => rect;
  const clientY = position === 'below' ? 15 : 0;
  fireDragEvent(ctx, from, 'mousedown');
  fireDragEvent(ctx, from, 'dragstart');
  const over = fireDragEvent(ctx, to, 'dragover', { clientY });
  fireDragEvent(ctx, to, 'drop', { clientY });
  fireDragEvent(ctx, from, 'dragend');
  return over;
}

/** 双模式参数化 */
const MODES = DIST_READY ? ['wysiwyg', 'ir'] : [];

// ── D：拖拽重排（源文件真实重排） ────────────────────────────────────────
describe('outline drag reorder', { skip: !DIST_READY }, () => {
  MODES.forEach((mode) => {
    describe(`mode=${mode}`, () => {
      it('D1: 上方插入 — h2 治理区域整体移到 h1 之前', async () => {
        const ctx = await boot(MD_DND, { mode });
        try {
          await settle();
          assert.equal(outlineRows(ctx).length, 3, '前置：三个标题行');
          dragRowTo(ctx, 1, 0, 'above');
          await settle();
          assert.equal(getMd(ctx), stripTailingNewlines([
            '## Alpha Sub', '', 'sub body', '',
            '# Alpha', '', 'alpha intro', '',
            '# Beta', '', 'beta one', '', 'beta two',
          ].join('\n')));
          // 大纲结构同步重建：h2 行已在最前
          assert.match(outlineRows(ctx)[0].textContent, /Alpha Sub/);
        } finally {
          ctx.window.close();
        }
      });

      it('D2: 末行下方 — h1 整棵子树（含 h2 子节）追加到文档末尾', async () => {
        const ctx = await boot(MD_DND, { mode });
        try {
          await settle();
          dragRowTo(ctx, 0, 2, 'below');
          await settle();
          assert.equal(getMd(ctx), stripTailingNewlines([
            '# Beta', '', 'beta one', '', 'beta two', '',
            '# Alpha', '', 'alpha intro', '', '## Alpha Sub', '', 'sub body',
          ].join('\n')));
        } finally {
          ctx.window.close();
        }
      });

      it('D3: 下方插入 — h2 区域移到最后一个 h1 区域之前', async () => {
        const ctx = await boot(MD_DND, { mode });
        try {
          await settle();
          dragRowTo(ctx, 1, 2, 'below');
          await settle();
          // 末行下方=文档末尾：h2 区域（标题+正文）原样移到 Beta 两段正文之后
          assert.equal(getMd(ctx), stripTailingNewlines([
            '# Alpha', '', 'alpha intro', '',
            '# Beta', '', 'beta one', '', 'beta two', '',
            '## Alpha Sub', '', 'sub body',
          ].join('\n')));
        } finally {
          ctx.window.close();
        }
      });

      it('D4: 拖入自身治理区域 — 拒绝且不产生任何变更', async () => {
        const ctx = await boot(MD_DND, { mode });
        try {
          await settle();
          const before = getMd(ctx);
          const beforeRows = outlineRows(ctx).map((r) => r.textContent);
          // h1(Alpha) 区域包含 h2 → 放到 h2 行上方 = 自嵌，拒绝
          dragRowTo(ctx, 0, 1, 'above');
          await settle();
          assert.equal(getMd(ctx), before, '源文本不应变化');
          assert.deepEqual(outlineRows(ctx).map((r) => r.textContent), beforeRows, '大纲不应变化');
        } finally {
          ctx.window.close();
        }
      });

      it('D5: 原位等价放置 — 无操作且不触发保存链', async () => {
        const inputs = [];
        const ctx = await boot(MD_DND, { mode, inputs });
        try {
          await sleep(800);
          const before = getMd(ctx);
          const baseline = inputs.length;
          // h2 行放到 h1(Alpha) 行下方 = 插到自身当前位置 = 等价无操作
          dragRowTo(ctx, 1, 0, 'below');
          await sleep(1000);
          assert.equal(getMd(ctx), before, '源文本不应变化');
          assert.equal(inputs.length, baseline, '等价无操作不应触发 options.input（宿主保存链静默）');
        } finally {
          ctx.window.close();
        }
      });

      it('D6: undo 一次完整恢复重排前文档', async () => {
        const ctx = await boot(MD_DND, { mode });
        try {
          // 等待 boot 初始快照入栈（undoDelay 600ms debounce）
          await sleep(800);
          dragRowTo(ctx, 1, 0, 'above');
          await sleep(800);
          assert.notEqual(getMd(ctx), stripTailingNewlines(MD_DND), '前置：重排已发生');
          inner(ctx).undo.undo(inner(ctx));
          await settle();
          assert.equal(getMd(ctx), stripTailingNewlines(MD_DND), 'undo 应恢复原文档');
        } finally {
          ctx.window.close();
        }
      });

      it('D7: 重排触发 options.input — 保存链（webview save 消息）连通', async () => {
        const inputs = [];
        const ctx = await boot(MD_DND, { mode, inputs });
        try {
          await sleep(800);
          const baseline = inputs.length;
          dragRowTo(ctx, 0, 2, 'below');
          await sleep(1000);
          assert.ok(inputs.length > baseline, 'input 回调应被触发');
          assert.equal(
            stripTailingNewlines(inputs[inputs.length - 1]),
            stripTailingNewlines([
              '# Beta', '', 'beta one', '', 'beta two', '',
              '# Alpha', '', 'alpha intro', '', '## Alpha Sub', '', 'sub body',
            ].join('\n')),
            '最后一次 input 应携带重排后的全文',
          );
        } finally {
          ctx.window.close();
        }
      });
      it('D8: 拖拽中途大纲重建重编号 id — 拖拽对象按元素引用不漂移', async () => {
        const ctx = await boot('# A\n\na body\n\n# C\n\nc body\n', { mode });
        try {
          await settle();
          const editor = resetEl(ctx);
          const sourceRow = outlineRows(ctx)[1]; // C 行
          fireDragEvent(ctx, sourceRow, 'mousedown');
          fireDragEvent(ctx, sourceRow, 'dragstart');
          // 拖拽中途文档头部插入新标题，防抖定时器触发大纲重建 → 标题 id 按位置整体重编号
          const heading = ctx.document.createElement('h1');
          heading.textContent = 'Z';
          editor.insertBefore(heading, editor.firstChild);
          inner(ctx).outline.render(inner(ctx));
          await settle();
          // 落到重建后的 A 行上方：应移动抓起的 C 区域，而不是旧 id 漂移后指向的 A
          const targetRow = outlineRows(ctx)[1]; // [Z, A, C] 中的 A
          targetRow.getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 0, width: 100, height: 0 });
          fireDragEvent(ctx, targetRow, 'dragover', { clientY: 0 });
          fireDragEvent(ctx, targetRow, 'drop', { clientY: 0 });
          fireDragEvent(ctx, sourceRow, 'dragend'); // 源行已脱离文档；状态已在 drop 内清理
          await settle();
          assert.deepEqual(
            outlineRows(ctx).map((r) => contentSpanOf(r).textContent.trim()),
            ['Z', 'C', 'A'],
            '移动的应是抓起的 C 区域',
          );
          const headings = Array.from(resetEl(ctx).children)
            .filter((el) => /^H[1-6]$/.test(el.tagName))
            .map((el) => el.textContent.replace(/#+/g, '').trim());
          assert.deepEqual(headings, ['Z', 'C', 'A'], '编辑器内标题顺序应一致');
        } finally {
          ctx.window.close();
        }
      });

      it('D9: 非大纲拖拽（无自定义 MIME）落在大纲面板 — 不触发重排', async () => {
        const ctx = await boot(MD_DND, { mode });
        try {
          await settle();
          const before = getMd(ctx);
          const sourceRow = outlineRows(ctx)[0];
          // 模拟残留拖拽状态 + 外来拖放（如编辑器内选中文字拖入面板）：无自定义 MIME
          fireDragEvent(ctx, sourceRow, 'dragstart');
          const targetRow = outlineRows(ctx)[2];
          targetRow.getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 });
          fireDragEvent(ctx, targetRow, 'dragover', { clientY: 15, types: ['text/plain'] });
          fireDragEvent(ctx, targetRow, 'drop', { clientY: 15, types: ['text/plain'] });
          fireDragEvent(ctx, sourceRow, 'dragend', { types: ['text/plain'] });
          await settle();
          assert.equal(getMd(ctx), before, '外来拖放不应触发章节重排');
        } finally {
          ctx.window.close();
        }
      });

      it('D10: 指示线单线锚定插入边界 — below 与下一行 above 同位置', async () => {
        const ctx = await boot(MD_DND, { mode });
        try {
          await settle();
          const sourceRow = outlineRows(ctx)[2]; // 拖 h1(Beta)
          fireDragEvent(ctx, sourceRow, 'mousedown');
          fireDragEvent(ctx, sourceRow, 'dragstart');
          const dropClasses = (row) => ['vditor-outline__item--drop-above', 'vditor-outline__item--drop-below']
            .filter((c) => row.classList.contains(c));
          const totalIndicated = () => outlineRows(ctx).filter((r) => dropClasses(r).length > 0).length;
          // ① 悬停 row0 下半：插入边界在 row1 之前 → 线画在 row1 顶部
          outlineRows(ctx)[0].getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 });
          fireDragEvent(ctx, outlineRows(ctx)[0], 'dragover', { clientY: 15 });
          assert.deepEqual(dropClasses(outlineRows(ctx)[1]), ['vditor-outline__item--drop-above'], 'below 落点的线应锚定下一行顶部');
          assert.equal(dropClasses(outlineRows(ctx)[0]).length, 0, '悬停行自身不应有线');
          assert.equal(totalIndicated(), 1, '同时只有一根线');
          // ② 悬停 row1 上半：同一插入边界 → 同一行同一根线
          outlineRows(ctx)[1].getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 0, width: 100, height: 0 });
          fireDragEvent(ctx, outlineRows(ctx)[1], 'dragover', { clientY: 0 });
          assert.deepEqual(dropClasses(outlineRows(ctx)[1]), ['vditor-outline__item--drop-above'], 'above 落点与 below 同边界应同位置');
          assert.equal(totalIndicated(), 1);
          // ③ 文档末尾插入：改拖 h2（拖最后一行 B 放其下方是原位等价无操作，无指示线），
          //    悬停最后一行下半 → 线在最后一行底部
          fireDragEvent(ctx, outlineRows(ctx)[1], 'dragstart');
          outlineRows(ctx)[2].getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 });
          fireDragEvent(ctx, outlineRows(ctx)[2], 'dragover', { clientY: 15 });
          assert.deepEqual(dropClasses(outlineRows(ctx)[2]), ['vditor-outline__item--drop-below'], '文档末尾插入的线在最后一行底部');
          assert.equal(totalIndicated(), 1);
          // ④ 下一行处于折叠子树（ul display:none）：改回拖 B，线回退到悬停行底部
          fireDragEvent(ctx, sourceRow, 'dragstart');
          outlineRows(ctx)[1].closest('ul').style.display = 'none';
          fireDragEvent(ctx, outlineRows(ctx)[0], 'dragover', { clientY: 15 });
          assert.deepEqual(dropClasses(outlineRows(ctx)[0]), ['vditor-outline__item--drop-below'], '下一行不可见时线回退悬停行底部');
          assert.equal(totalIndicated(), 1);
          fireDragEvent(ctx, sourceRow, 'dragend');
        } finally {
          ctx.window.close();
        }
      });
    });
  });
});

// ── S：标式透传（行内格式 + 元素级 CSS 快照） ─────────────────────────────
describe('outline style passthrough', { skip: !DIST_READY }, () => {
  const MD_FMT = '# Head **bold** *it* `code` ~~del~~\n\nbody text\n';

  MODES.forEach((mode) => {
    describe(`mode=${mode}`, () => {
      it('S1: 条目透传行内格式标签（strong/em/code/s）', async () => {
        const ctx = await boot(MD_FMT, { mode });
        try {
          await settle();
          const rows = outlineRows(ctx);
          assert.equal(rows.length, 1, '前置：单个标题行');
          const html = contentSpanOf(rows[0]).innerHTML;
          assert.match(html, /<strong[^>]*>[^<]*bold<\/strong>/, '加粗标签应透传');
          assert.match(html, /<em[^>]*>[^<]*it<\/em>/, '斜体标签应透传');
          // wysiwyg 的 code 文本前可能有零宽字符，用 [^<] 兜住
          assert.match(html, /<code[^>]*>[^<]*code<\/code>/, '行内代码标签应透传');
          assert.match(html, /<s[^>]*>[^<]*del<\/s>/, '删除线标签应透传（ir 路径 Lute 会丢弃）');
          assert.ok(!html.includes('vditor-ir__marker'), 'ir marker 语法不应出现在大纲');
        } finally {
          ctx.window.close();
        }
      });

      it('S2: 标题被 CSS 控制 — 偏差属性注入条目，font-size/font-weight 恒不透传', async () => {
        const ctx = await boot('# Styled\n\nbody\n', { mode });
        try {
          await settle();
          const editor = resetEl(ctx);
          const heading = Array.from(editor.children).find((el) => /^H[1-6]$/.test(el.tagName));
          assert.ok(heading, '前置：找到标题元素');
          // 编辑器根内联基线 + 标题差异（jsdom 可靠解析内联样式）
          editor.style.color = 'rgb(0, 0, 0)';
          heading.style.color = 'rgb(255, 0, 0)';
          heading.style.fontWeight = '400';
          heading.style.fontSize = '30px';
          inner(ctx).outline.render(inner(ctx));
          await settle();
          const style = contentSpanOf(outlineRows(ctx)[0]).getAttribute('style') || '';
          assert.match(style, /color:\s*rgb\(255, 0, 0\)/, 'CSS 颜色偏差应注入');
          assert.ok(!style.includes('font-size'), 'font-size 恒不透传');
          assert.ok(!style.includes('font-weight'), 'font-weight 恒不透传（标题层级字重不进大纲，行内加粗靠标签直通）');
        } finally {
          ctx.window.close();
        }
      });

      it('S3: 无 CSS 偏差时不注入任何内联样式', async () => {
        const ctx = await boot('# Plain\n\nbody\n', { mode });
        try {
          await settle();
          const editor = resetEl(ctx);
          editor.style.color = 'rgb(1, 1, 1)';
          const heading = Array.from(editor.children).find((el) => /^H[1-6]$/.test(el.tagName));
          heading.style.color = 'rgb(1, 1, 1)';
          inner(ctx).outline.render(inner(ctx));
          await settle();
          assert.equal(contentSpanOf(outlineRows(ctx)[0]).getAttribute('style'), null);
        } finally {
          ctx.window.close();
        }
      });

      it('S5: 行内代码含 & — 直通路径单次转义显示', async () => {
        const ctx = await boot('# Head `a && b` tail\n\nbody\n', { mode });
        try {
          await settle();
          const text = contentSpanOf(outlineRows(ctx)[0]).textContent;
          assert.ok(text.includes('a && b'), `code 芯片应显示字面 &&，实际: ${JSON.stringify(text)}`);
          assert.ok(!text.includes('&amp;'), '直通路径不应叠加转义');
        } finally {
          ctx.window.close();
        }
      });

      it('S6: 直通内容剥离 on* 事件属性（纵深防御）', async () => {
        const ctx = await boot('# Head `code` tail\n\nbody\n', { mode });
        try {
          await settle();
          const code = resetEl(ctx).querySelector('h1 code');
          assert.ok(code, '前置：标题内 code 元素');
          code.setAttribute('onclick', 'alert(1)');
          inner(ctx).outline.render(inner(ctx));
          await settle();
          const html = contentSpanOf(outlineRows(ctx)[0]).innerHTML;
          assert.ok(!/on[a-z]+\s*=/i.test(html), '大纲直通内容不应携带事件属性');
          // 剥离只应作用于克隆，不污染编辑器 DOM
          assert.ok(code.hasAttribute('onclick'), '编辑器原元素的 onclick 应保留');
        } finally {
          ctx.window.close();
        }
      });
    });
  });

  it('S4: CSS 契约 — 大纲作用域含拖拽指示线与行内元素样式', () => {
    const css = fs.readFileSync(path.join(DIST, 'index.css'), 'utf8');
    assert.ok(css.includes('vditor-outline__item--dragging'), '拖拽源行类名');
    assert.ok(css.includes('vditor-outline__item--drop-above'), '上方指示线类名');
    assert.ok(css.includes('vditor-outline__item--drop-below'), '下方指示线类名');
    // 大纲作用域内的行内 code 外观（对齐编辑器 --code-* 变量）
    const outlineCode = /\.vditor-outline[^{}]*li>span>span[^{}]*code\s*\{[^}]*--code-font-family/;
    assert.match(css, outlineCode, '大纲条目行内 code 应使用编辑器 code 字体变量');
    // less 嵌套下 s, del 编译为两条完整前缀选择器，断言 del 一侧即可
    assert.match(css, /\.vditor-outline[^{}]*li>span>span[^{}]*\bdel\s*\{[^}]*line-through/, '删除线样式');
    // 指示线单线契约：每个落点类只激活一个伪元素（合并选择器会产生游离的第二根线）；
    // 压缩器会把 ::before/::after 规范成单冒号，正则需兼容两种写法
    assert.ok(!/--drop-above:{1,2}after/.test(css), 'drop-above 不应激活 ::after');
    assert.ok(!/--drop-below:{1,2}before/.test(css), 'drop-below 不应激活 ::before');
  });
});
