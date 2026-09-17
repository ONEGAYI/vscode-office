'use strict';

/**
 * Webview 集成测试 — 外部 CSS 叠加层（resource/markdown/custom-css.js）
 *
 * 机制：host 把 `~/.vscode-office-css/*.css` 按文件名字母序拼成一个
 * cssText，经 open 载荷下发 + `customCss` 广播热更新；webview 侧由
 * CustomCss.applyCustomCss 幂等维护单个 `<style id="office-custom-css">`
 * （head 末尾，两个内置 <link> 之后，级联天然优先）。
 *
 * 分组：
 * - A：applyCustomCss 行为契约（jsdom eval 模块源码）
 * - W：接线契约（index.html/js、provider、host service）
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'resource', 'markdown', 'custom-css.js');
const HTML_PATH = path.join(ROOT, 'resource', 'markdown', 'index.html');
const INDEXJS_PATH = path.join(ROOT, 'resource', 'markdown', 'index.js');
const PROVIDER_PATH = path.join(ROOT, 'src', 'provider', 'markdownEditorProvider.ts');
const SERVICE_PATH = path.join(ROOT, 'src', 'service', 'markdown', 'customCssService.ts');

const read = (p) => fs.readFileSync(p, 'utf8');

/** 模拟 webview head：两个内置 <link> 之后挂叠加层 */
function bootDom() {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head>'
    + '<link rel="stylesheet" href="dist/index.css" />'
    + '<link rel="stylesheet" href="index.css" />'
    + '</head><body><div id="vditor"></div></body></html>',
    { runScripts: 'dangerously' },
  );
  dom.window.eval(read(MODULE_PATH));
  return dom.window;
}

describe('A. applyCustomCss 行为契约', () => {
  it('创建单个 style 元素并注入 textContent', () => {
    const window = bootDom();
    window.CustomCss.applyCustomCss('body { color: red }');
    const style = window.document.getElementById('office-custom-css');
    assert.ok(style, 'style 元素存在');
    assert.equal(style.tagName, 'STYLE');
    assert.equal(style.textContent, 'body { color: red }');
  });

  it('位置在两个内置 link 之后（级联优先的结构保证）', () => {
    const window = bootDom();
    window.CustomCss.applyCustomCss('p {}');
    const head = window.document.head;
    const style = window.document.getElementById('office-custom-css');
    const links = head.querySelectorAll('link[rel="stylesheet"]');
    assert.equal(links.length, 2);
    // head 内最后挂载 = 排在两个内置 link 之后
    assert.strictEqual(head.lastElementChild, style);
    for (const link of links) {
      assert.equal(style.compareDocumentPosition(link) & window.Node.DOCUMENT_POSITION_PRECEDING,
        window.Node.DOCUMENT_POSITION_PRECEDING, '每个内置 link 都先于 style');
    }
  });

  it('幂等：重复调用替换内容，不叠加元素', () => {
    const window = bootDom();
    window.CustomCss.applyCustomCss('a { color: red }');
    window.CustomCss.applyCustomCss('a { color: blue }');
    const styles = window.document.querySelectorAll('#office-custom-css');
    assert.equal(styles.length, 1, '始终只有一个 style 元素');
    assert.equal(styles[0].textContent, 'a { color: blue }');
  });

  it('自愈末位：后续元素插到 head 后，再次应用回到末尾', () => {
    const window = bootDom();
    window.CustomCss.applyCustomCss('a { color: red }');
    // 模拟 vditor 运行时注入样式（如代码主题）排在叠加层之后
    const runtimeStyle = window.document.createElement('style');
    runtimeStyle.id = 'vditor-runtime-style';
    window.document.head.appendChild(runtimeStyle);
    window.CustomCss.applyCustomCss('a { color: red }');
    assert.strictEqual(window.document.head.lastElementChild.id, 'office-custom-css',
      '再次应用把叠加层顶回 head 末尾，压过运行时注入的样式');
  });

  it('空串移除元素（目录清空后叠加层退场）', () => {
    const window = bootDom();
    window.CustomCss.applyCustomCss('a { color: red }');
    window.CustomCss.applyCustomCss('');
    assert.equal(window.document.getElementById('office-custom-css'), null);
    // 空串在无元素时也是安全的 no-op
    window.CustomCss.applyCustomCss('');
    assert.equal(window.document.getElementById('office-custom-css'), null);
  });

  it('textContent 通道：内容里的 </style> 不解析逃逸', () => {
    const window = bootDom();
    const hostile = 'p::after { content: "</style><script>window.pwned=1</script>" }';
    window.CustomCss.applyCustomCss(hostile);
    const style = window.document.getElementById('office-custom-css');
    assert.equal(style.textContent, hostile);
    assert.equal(window.pwned, undefined);
    assert.equal(window.document.querySelectorAll('script').length, 0);
  });
});

describe('W. 接线契约', () => {
  it('index.html 在 index.js 之前加载 custom-css.js', () => {
    const html = read(HTML_PATH);
    const moduleTag = html.indexOf('custom-css.js');
    const entryTag = html.indexOf('src="index.js"');
    assert.ok(moduleTag >= 0, 'index.html 引用 custom-css.js');
    assert.ok(entryTag > moduleTag, 'custom-css.js 先于 index.js 加载');
  });

  it('index.js：open 载荷消费 customCss，且在 new Vditor 之前应用', () => {
    const src = read(INDEXJS_PATH);
    const destructure = src.indexOf('customCss } = md');
    const apply = src.indexOf('window.CustomCss?.applyCustomCss(customCss)');
    const ctor = src.indexOf("new Vditor('vditor'");
    assert.ok(destructure >= 0, 'open 载荷解构包含 customCss');
    assert.ok(apply > destructure, '解构后应用叠加层');
    assert.ok(ctor > apply, '叠加层在 Vditor 创建之前生效（首帧无闪变）');
  });

  it('index.js：customCss 热更新监听注册在顶层（open 之前），不依赖编辑器就绪', () => {
    const src = read(INDEXJS_PATH);
    const listenAt = src.indexOf("handler.on('customCss'");
    const openAt = src.indexOf('handler.on("open"');
    assert.ok(listenAt >= 0, 'customCss 监听存在');
    assert.ok(openAt > listenAt, '监听先于 open 注册：vditor 初始化期间的广播不丢失');
    assert.ok(/CustomCss\?\.applyCustomCss\(payload\?\.cssText\)/.test(src),
      '广播走同一条 applyCustomCss 路径（可选链兜底）');
    const afterBlock = src.split(/after\(\)\s*\{/)[1] ?? '';
    assert.ok(!/handler\.on\('customCss'/.test(afterBlock), 'after() 内无重复注册');
  });

  it('provider：预热 + open 载荷 + telemetry 计数', () => {
    const src = read(PROVIDER_PATH);
    assert.ok(/await CustomCssService\.loadForWebview\(\)/.test(src),
      'resolveCustomTextEditor 预热（watcher 与计数就绪先于 telemetry）');
    assert.ok(/customCssCount:\s*String\(CustomCssService\.snippetCount\)/.test(src),
      'telemetry 属性含 customCssCount（string 序列化）');
    const openPayload = src.split('handler.emit("open"')[1]?.split('})')[0] ?? '';
    assert.ok(/customCss,/.test(openPayload), 'open 载荷含 customCss 字段');
  });

  it('host service：广播事件名、载荷字段与去抖', () => {
    const src = read(SERVICE_PATH);
    assert.ok(/broadcastToMarkdownWebviews\('customCss',\s*\{\s*cssText:\s*result\.cssText\s*\}\)/.test(src),
      'watcher 去抖后广播 customCss { cssText }');
    assert.ok(/WATCH_DEBOUNCE_MS = 300/.test(src), '去抖窗口 300ms');
    assert.ok(/createFileSystemWatcher/.test(src) && /\*\*\/\*\.css/.test(src),
      'watcher 覆盖目录下全部 css');
  });

  it('host service：失败保形与计数语义', () => {
    const src = read(SERVICE_PATH);
    assert.ok(/if \(result !== undefined\)/.test(src), '目录级失败时不广播（保持上次叠加层）');
    assert.ok(/name\.name !== 'README\.css'/.test(src), '计数排除脚手架 README.css（0=未启用）');
    assert.ok(/\(type & vscode\.FileType\.File\) === 0/.test(src), 'symlink 的 css 按位判定不被排除');
  });
});
