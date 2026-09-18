'use strict';

/**
 * Webview 集成测试 — 图表弹窗预览（vditor diagramPopup + mermaid/plantuml chrome）
 *
 * 链路：真实构建产物 index.min.js，经 Vditor.mermaidRender / plantumlRender
 * 驱动 chrome 落位（含 popup 按钮），再以 DOM 事件驱动弹窗行为。
 * mermaid 以失败桩渲染（chrome 在错误态同样落位，弹窗守卫按 svg 判定），
 * plantuml 用真实 encoder 离线渲染。
 *
 * jsdom 限制：getBoundingClientRect 恒零 → 初始 fit 恒为 1，
 * 缩放锚点数值可据此精确断言；wheel 事件经 defineProperty 注入 deltaY。
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

const DIST_READY = fs.existsSync(path.join(DIST, 'index.min.js'))
  && fs.existsSync(path.join(DIST, 'js', 'i18n', 'en_US.js'));

const fileUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OVERLAY = 'vditor-diagram-overlay';
const MERMAID_CODE = 'graph TD\n  A-->B';
const PLANTUML_CODE = '@startuml\nalice -> bob: hi\n@enduml';

let ctx;

const buildMermaidHost = (doc, withSvg) => {
  const host = doc.createElement('div');
  host.className = 'vditor-mermaid-host';
  host.setAttribute('data-mermaid-theme', 'Forest');
  const mermaidEl = doc.createElement('div');
  mermaidEl.className = 'language-mermaid';
  if (withSvg) {
    mermaidEl.innerHTML = '<svg viewBox="0 0 120 80"><rect width="120" height="80"/></svg>';
  }
  host.appendChild(mermaidEl);
  doc.body.appendChild(host);
  return host;
};

const buildPlantumlHost = (doc, src) => {
  const figure = doc.createElement('div');
  figure.className = 'vditor-plantuml-figure';
  const img = doc.createElement('img');
  img.setAttribute('src', src);
  figure.appendChild(img);
  doc.body.appendChild(figure);
  return figure;
};

// 所有取值限定在活跃弹窗内：关闭中的弹窗在 220ms 动画期仍在文档中，
// 全局 querySelector 会命中旧弹窗的同名节点
const overlayEl = (doc) => doc.querySelector(`.${OVERLAY}:not(.${OVERLAY}--closing)`);
const contentEl = (doc) => overlayEl(doc)?.querySelector(`.${OVERLAY}__content`);
const stageEl = (doc) => overlayEl(doc)?.querySelector(`.${OVERLAY}__stage`);
const toolbarBtn = (doc, action) =>
  overlayEl(doc)?.querySelector(`.${OVERLAY}__btn[data-action='${action}']`);
const zoomLabel = (doc) => overlayEl(doc)?.querySelector(`.${OVERLAY}__zoom-label`);
const parseTransform = (el) => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(el.style.transform || '');
  return m ? { x: Number(m[1]), y: Number(m[2]), s: Number(m[3]) } : null;
};

const click = (win, el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (win, k) => win.document.dispatchEvent(new win.KeyboardEvent('keydown', {
  key: k, bubbles: true, cancelable: true,
}));

const wheel = (win, el, deltaY, clientX, clientY) => {
  const Ctor = win.WheelEvent || win.MouseEvent;
  const evt = new Ctor('wheel', { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(evt, 'deltaY', { value: deltaY });
  el.dispatchEvent(evt);
};

const drag = (win, stage, x1, y1, x2, y2) => {
  stage.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x1, clientY: y1 }));
  win.document.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: x2, clientY: y2 }));
  win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y2 }));
};

const closePopup = () => {
  if (overlayEl(ctx.document)) {
    ctx.window.Vditor.closeDiagramPopup();
  }
};

before(async () => {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (err) => pageErrors.push(String(err)));

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    runScripts: 'dangerously',
    resources: 'usable',
    url: fileUrl(path.join(ROOT, '__diagram-popup-test__.html')),
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

  // i18n 与 vditor 主体（无需完整编辑器实例）
  window.eval(fs.readFileSync(path.join(DIST, 'js', 'i18n', 'en_US.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(DIST, 'index.min.js'), 'utf8'));
  if (typeof window.Vditor === 'undefined') {
    throw new Error('Vditor did not load; page errors: ' + pageErrors.join(' | ').slice(0, 2000));
  }

  // mermaid：失败桩（addScript 以元素 id 去重，桩标签即可短路加载）
  window.mermaid = {
    initialize() { },
    render: async () => { throw new Error('mermaid stub'); },
  };
  const stubScript = (id) => {
    const s = document.createElement('script');
    s.id = id;
    document.head.appendChild(s);
  };
  stubScript('vditorMermaidScript');

  // plantuml：真实 encoder 离线编码（UMD → window.plantumlEncoder）
  window.eval(fs.readFileSync(path.join(DIST, 'js', 'plantuml', 'plantuml-encoder.min.js'), 'utf8'));
  stubScript('vditorPlantumlScript');

  ctx = { window, document };
});

describe('diagram-popup: popup behavior (P)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {

  it('P1: opens overlay with cloned mermaid svg and carried theme', () => {
    const host = buildMermaidHost(ctx.document, true);
    ctx.window.Vditor.openDiagramPopup({ host, kind: 'mermaid' });
    const overlay = overlayEl(ctx.document);
    assert.ok(overlay, 'overlay should be in the document');
    assert.equal(overlay.getAttribute('role'), 'dialog');
    assert.equal(overlay.getAttribute('aria-modal'), 'true');
    assert.equal(overlay.getAttribute('aria-label'), 'Open in popup');
    const content = contentEl(ctx.document);
    assert.ok(content, 'content wrapper exists');
    assert.ok(content.classList.contains('vditor-mermaid-host'));
    assert.equal(content.getAttribute('data-mermaid-theme'), 'Forest');
    assert.ok(content.querySelector('svg'), 'cloned svg present');
    // jsdom stage 尺寸恒零 → 初始 fit = 1
    assert.deepEqual(parseTransform(content), { x: 0, y: 0, s: 1 });
    closePopup();
    host.remove();
  });

  it('P2: toolbar has zoom/reset/close, download only with callback', () => {
    const host = buildMermaidHost(ctx.document, true);
    ctx.window.Vditor.openDiagramPopup({ host, kind: 'mermaid' });
    for (const action of ['zoom-in', 'zoom-out', 'reset', 'close']) {
      assert.ok(toolbarBtn(ctx.document, action), `button ${action} exists`);
    }
    assert.equal(toolbarBtn(ctx.document, 'download'), null);
    assert.ok(zoomLabel(ctx.document));
    closePopup();

    const captured = [];
    ctx.window.Vditor.openDiagramPopup({
      host, kind: 'mermaid',
      vditor: { options: { onDiagramDownload: (p) => captured.push(p) } },
    });
    const dl = toolbarBtn(ctx.document, 'download');
    assert.ok(dl, 'download button appears with callback');
    click(ctx.window, dl);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].kind, 'mermaid');
    assert.equal(captured[0].fileName, 'mermaid-diagram.svg');
    assert.match(captured[0].svg, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(captured[0].svg, /<svg[^>]*width="120"[^>]*height="80"/);
    closePopup();
    host.remove();
  });

  it('P3: wheel zooms anchored at cursor', () => {
    const host = buildMermaidHost(ctx.document, true);
    ctx.window.Vditor.openDiagramPopup({ host, kind: 'mermaid' });
    wheel(ctx.window, overlayEl(ctx.document), -100, 100, 50);
    // jsdom stage rect 恒零：origin=(100,50)，ratio=1.2 → pan=-0.2*origin
    assert.deepEqual(parseTransform(contentEl(ctx.document)), { x: -20, y: -10, s: 1.2 });
    assert.equal(zoomLabel(ctx.document).textContent, '120%');
    // 反向滚轮回缩，锚点保持内容不动
    wheel(ctx.window, overlayEl(ctx.document), 100, 100, 50);
    const t = parseTransform(contentEl(ctx.document));
    assert.ok(Math.abs(t.s - 1) < 1e-9);
    assert.ok(Math.abs(t.x) < 1e-9 && Math.abs(t.y) < 1e-9);
    closePopup();
    host.remove();
  });

  it('P4: keyboard +/-/0/arrows drive zoom and pan', () => {
    const host = buildMermaidHost(ctx.document, true);
    ctx.window.Vditor.openDiagramPopup({ host, kind: 'mermaid' });
    key(ctx.window, '+');
    assert.equal(parseTransform(contentEl(ctx.document)).s, 1.2);
    key(ctx.window, '-');
    assert.equal(parseTransform(contentEl(ctx.document)).s, 1);
    key(ctx.window, 'ArrowLeft');
    key(ctx.window, 'ArrowDown');
    assert.deepEqual(parseTransform(contentEl(ctx.document)), { x: -40, y: 40, s: 1 });
    key(ctx.window, '0');
    assert.deepEqual(parseTransform(contentEl(ctx.document)), { x: 0, y: 0, s: 1 });
    closePopup();
    host.remove();
  });

  it('P5: drag pans and suppresses click-close after movement', () => {
    const host = buildMermaidHost(ctx.document, true);
    ctx.window.Vditor.openDiagramPopup({ host, kind: 'mermaid' });
    const stage = stageEl(ctx.document);
    drag(ctx.window, stage, 10, 20, 40, 60);
    assert.deepEqual(parseTransform(contentEl(ctx.document)), { x: 30, y: 40, s: 1 });
    // 拖拽后的落点单击不关闭
    click(ctx.window, stage);
    assert.ok(overlayEl(ctx.document), 'overlay survives click after drag');
    closePopup();
    host.remove();
  });

  it('P6: plain stage click and Escape close the overlay', async () => {
    const host = buildMermaidHost(ctx.document, true);
    ctx.window.Vditor.openDiagramPopup({ host, kind: 'mermaid' });
    click(ctx.window, stageEl(ctx.document));
    let overlay = overlayEl(ctx.document);
    assert.equal(overlay, null, 'overlay closed on stage click');
    assert.equal(ctx.document.body.style.overflow, '');
    assert.ok(ctx.document.querySelector(`.${OVERLAY}`), 'closing overlay still animating out');

    ctx.window.Vditor.openDiagramPopup({ host, kind: 'mermaid' });
    key(ctx.window, 'Escape');
    assert.equal(overlayEl(ctx.document), null, 'overlay closed on Escape');
    await sleep(320);
    assert.equal(ctx.document.querySelectorAll(`.${OVERLAY}`).length, 0, 'overlay removed after animation');
    host.remove();
  });

  it('P7: reopening replaces the active overlay (singleton)', () => {
    const hostA = buildMermaidHost(ctx.document, true);
    const hostB = buildMermaidHost(ctx.document, true);
    ctx.window.Vditor.openDiagramPopup({ host: hostA, kind: 'mermaid' });
    ctx.window.Vditor.openDiagramPopup({ host: hostB, kind: 'mermaid' });
    const overlays = ctx.document.querySelectorAll(`.${OVERLAY}:not(.${OVERLAY}--closing)`);
    assert.equal(overlays.length, 1);
    closePopup();
    hostA.remove();
    hostB.remove();
  });

  it('P8: zoom clamps at MAX_SCALE', () => {
    const host = buildMermaidHost(ctx.document, true);
    ctx.window.Vditor.openDiagramPopup({ host, kind: 'mermaid' });
    for (let i = 0; i < 80; i++) {
      wheel(ctx.window, overlayEl(ctx.document), -100, 0, 0);
    }
    assert.equal(parseTransform(contentEl(ctx.document)).s, 40);
    assert.equal(zoomLabel(ctx.document).textContent, '4000%');
    closePopup();
    host.remove();
  });

  it('P9: plantuml popup clones the img and downloads via url payload', () => {
    const src = 'http://www.plantuml.com/plantuml/svg/~1SoWkIImgAStDuNBAJrBGLq2';
    const figure = buildPlantumlHost(ctx.document, src);
    const captured = [];
    ctx.window.Vditor.openDiagramPopup({
      host: figure, kind: 'plantuml',
      vditor: { options: { onDiagramDownload: (p) => captured.push(p) } },
    });
    const img = contentEl(ctx.document).querySelector('img');
    assert.ok(img, 'img clone present');
    assert.equal(img.getAttribute('src'), src);
    click(ctx.window, toolbarBtn(ctx.document, 'download'));
    assert.deepEqual(captured, [{
      kind: 'plantuml',
      fileName: 'plantuml-diagram.svg',
      url: src,
    }]);
    closePopup();
    figure.remove();
  });

  it('P10: mermaid host without svg does not open', () => {
    const host = buildMermaidHost(ctx.document, false);
    ctx.window.Vditor.openDiagramPopup({ host, kind: 'mermaid' });
    assert.equal(overlayEl(ctx.document), null);
    host.remove();
  });

});

describe('diagram-popup: mermaid chrome integration (M)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {

  const renderMermaidBlock = () => {
    const holder = ctx.document.createElement('div');
    const code = ctx.document.createElement('div');
    code.className = 'language-mermaid';
    code.textContent = MERMAID_CODE;
    holder.appendChild(code);
    ctx.document.body.appendChild(holder);
    const fakeVditor = {
      element: ctx.document.body,
      options: { cdn: fileUrl(path.join(ROOT, 'vditor')), mermaidTheme: 'Auto' },
    };
    ctx.window.Vditor.mermaidRender(holder, fakeVditor.options.cdn, fakeVditor);
    return holder;
  };

  it('M1: chrome lands with popup button even in error render state', async () => {
    const holder = renderMermaidBlock();
    await sleep(50);
    const btn = holder.querySelector('.vditor-mermaid-chrome__popup-btn');
    assert.ok(btn, 'popup button present in mermaid chrome');
    assert.equal(btn.getAttribute('aria-label'), 'Open in popup');
    assert.ok(holder.querySelector('.vditor-mermaid-host'), 'host wrapper present');
    holder.remove();
  });

  it('M2: popup button click without svg is a no-op', async () => {
    const holder = renderMermaidBlock();
    await sleep(50);
    click(ctx.window, holder.querySelector('.vditor-mermaid-chrome__popup-btn'));
    assert.equal(overlayEl(ctx.document), null);
    holder.remove();
  });

  it('M3: popup opens with the injected svg', async () => {
    const holder = renderMermaidBlock();
    await sleep(50);
    const mermaidEl = holder.querySelector('.language-mermaid');
    mermaidEl.innerHTML = '<svg viewBox="0 0 60 40"><circle r="10"/></svg>';
    click(ctx.window, holder.querySelector('.vditor-mermaid-chrome__popup-btn'));
    const content = contentEl(ctx.document);
    assert.ok(content, 'overlay opened from chrome button');
    assert.ok(content.querySelector('circle'), 'current svg cloned');
    closePopup();
    holder.remove();
  });

});

describe('diagram-popup: plantuml chrome integration (U)', { skip: DIST_READY ? false : 'vditor/dist 未构建：先在 vditor/ 目录执行构建' }, () => {

  it('U1: render builds figure + popup button; popup clones the renderer img', async () => {
    const holder = ctx.document.createElement('div');
    const code = ctx.document.createElement('div');
    code.className = 'language-plantuml';
    code.textContent = PLANTUML_CODE;
    holder.appendChild(code);
    ctx.document.body.appendChild(holder);
    const fakeVditor = { options: { cdn: fileUrl(path.join(ROOT, 'vditor')) } };
    ctx.window.Vditor.plantumlRender(holder, fakeVditor.options.cdn, fakeVditor);

    for (let i = 0; i < 20 && !holder.querySelector('.vditor-plantuml-chrome__popup-btn'); i++) {
      await sleep(50);
    }
    const btn = holder.querySelector('.vditor-plantuml-chrome__popup-btn');
    assert.ok(btn, 'popup button present in plantuml chrome');
    const img = holder.querySelector('.vditor-plantuml-figure img');
    assert.ok(img, 'renderer img present');
    assert.match(img.getAttribute('src'), /^https?:\/\/www\.plantuml\.com\/plantuml\/svg\//);

    click(ctx.window, btn);
    const cloned = contentEl(ctx.document)?.querySelector('img');
    assert.ok(cloned, 'popup opened with img clone');
    assert.equal(cloned.getAttribute('src'), img.getAttribute('src'));
    closePopup();
    holder.remove();
  });

});
