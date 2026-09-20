/**
 * Block line numbers — source start line per top-level block (IR & WYSIWYG).
 *
 * Ported from vscode-markdown-editor-hardened `src/extension.ts`
 * lineNumberScript (d64e408; upstream PR #157 by asalcedo29). The scanner
 * is adapted for host source text; display and DOM binding are this fork's
 * own (see "Intentional divergences" below).
 *
 * What the user sees: every independent paragraph/block (h1-h6, p, ul/ol,
 * blockquote, table, code block, frontmatter …) carries the 1-based line
 * its first source line occupies in the host TextDocument, including
 * unsaved changes. The host refreshes sourceText after applying edits;
 * getValue() is only a fallback for standalone consumers without a host.
 * Lute's serialized blank lines must not replace host source positions.
 *
 * Display: a data-lineno attribute + CSS ::before/attr() (index.css).
 * The number rides on the block itself, so it scrolls/animates with the
 * document — no fixed gutter, no rect math, no scroll listeners.
 *
 * Hard constraint (fenced by test/webview/block-numbers.test.js):
 * data-lineno is presentation-only. It must never leak into markdown
 * output. Lute strips unknown attributes on spin, and the attribute is
 * re-applied presentation-side by the MutationObserver anyway — but the
 * fence test still asserts getValue() stays clean.
 *
 * Intentional divergences from the hardened source:
 *   - sourceText from the host is authoritative; setSource(null) pauses
 *     numbering until an edit is acknowledged, without reloading the DOM
 *   - raw syntax variants (setext, tabs, spaced rules, tilde/long fences)
 *     are recognized without relying on Lute to normalize the source
 *   - visibility: block-level tag whitelist instead of offsetHeight>0
 *     (offsetHeight is 0 in layout-less environments and only a proxy in
 *     browsers); the whitelist also naturally skips the fork's boundary
 *     sentinels (span.vditor-editor-boundary, see renderDomByMd.ts)
 *   - empty paragraphs (editing artifacts, e.g. Enter on the first line)
 *     neither take nor consume a number: a blank line belongs to no block
 *   - frontmatter is only recognized with a closing `---`; without one
 *     the leading `---` parses as a plain hr (the source swallowed the
 *     whole document into one block)
 *
 * Known limitations (documented, not fixed — verified against this
 * fork's Lute; when any of these fires, the block-count guard in sync()
 * degrades to "no numbers shown" rather than wrong numbers):
 *   - mixed list markers in one run ("- a" then "* b", "1." then "2)")
 *     merge into one scanned block where Lute splits them
 *   - a table line right after a quote (no blank line) joins the quote
 *     in Lute but breaks it here
 *   - an ordered list not starting at 1 does not interrupt a paragraph
 *   - html comments are not recognized
 *   - footnote definitions are aggregated by Lute into a trailing
 *     block, so both count and order can diverge
 *
 * Wiring (see resource/markdown/index.html + index.js):
 *   <script src="block-numbers.js"></script>  then
 *   BlockLineNumbers.install(editor, { enabled })  inside after()
 */
(function () {
  'use strict';

  var ON_CLASS = 'vmd-block-linenumbers';
  var OFF_CLASS = 'vmd-linenumbers-off';
  var ATTR = 'data-lineno';

  var currentEditor = null;
  // undefined: standalone/live getValue(); null: host edit awaiting acknowledgement.
  var sourceText;
  var enabled = true;
  var observer = null;
  var paragraphResizeObserver = null;
  var watchedParagraphs = [];
  var scheduled = false;

  // ── block scanner ────────────────────────────────────────────────────────

  var R_HEADING = /^#{1,6}(?:[\t ]|$)/;
  var R_SETEXT = /^(?:=+|-+)$/;
  var R_HR = /^(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/;
  var R_LI = /^[-*+][\t ]/;
  var R_OL = /^[0-9]+[.)][\t ]/;
  // 懒延续缩进行：空格或 Tab（编辑器 Tab 键即插入 \t，见 index.js tab:'\t'）
  var R_INDENT = /^[\t ]+\S/;
  var R_FENCE = /^(`{3,}|~{3,})/;

  function isBlockStart(s) {
    return R_HEADING.test(s) || R_LI.test(s) || R_OL.test(s)
      || R_FENCE.test(s) || s.indexOf('$$') === 0
      || s.charAt(0) === '|' || s.charAt(0) === '>'
      || R_HR.test(s);
  }

  /**
   * 列表行后无空行紧跟时哪些块起始形态要断块（对齐 Lute 实测）：
   * 顶格的 heading/quote/fence/$$/hr 分块；缩进的同类行（如列表项内
   * 嵌套的代码围栏 "  ```"）与表格行、普通文本并入列表内容。
   */
  function isListBreakingBlockStart(rawLine) {
    if (/^[\t ]/.test(rawLine)) {
      return false;
    }
    var s = rawLine.trim();
    return R_HEADING.test(s) || s.charAt(0) === '>'
      || R_FENCE.test(s) || s.indexOf('$$') === 0 || R_HR.test(s);
  }

  /**
   * 1-based start line of every block in the given markdown text.
   * Empty lines belong to no block; the last block may run to EOF.
   */
  function computeBlockStarts(src) {
    var L = String(src == null ? '' : src).split('\n');
    var starts = [];
    var i = 0;

    if (L.length > 0 && L[0].trim() === '---') {
      var close = 1;
      while (close < L.length && L[close].trim() !== '---') close++;
      if (close < L.length) {
        starts.push(1);
        i = close + 1;
      }
    }

    while (i < L.length) {
      var tr = L[i].trim();
      if (tr === '') { i++; continue; }
      starts.push(i + 1);
      if (R_HEADING.test(tr) || R_HR.test(tr)) {
        i++;
      } else if (R_FENCE.test(tr) || tr.indexOf('$$') === 0) {
        // fence / 数学块：单行自闭合（$$..$$ 同行闭合）只占一行，
        // 否则吞到闭合行或 EOF
        if (tr.indexOf('$$') === 0 && tr.length > 4 && tr.lastIndexOf('$$') > 0) {
          i++;
        } else {
          var fence = tr.match(R_FENCE);
          // 围栏必须同字符且闭合长度不小于开启长度；代码里的短围栏不是结尾。
          var closer = fence ? new RegExp('^' + fence[1].charAt(0) + '{' + fence[1].length + ',}$') : /^\$\$/;
          i++;
          while (i < L.length && !closer.test(L[i].trim())) i++;
          if (i < L.length) i++;
        }
      } else if (tr.charAt(0) === '|') {
        while (i < L.length && L[i].trim().charAt(0) === '|') i++;
      } else if (tr.charAt(0) === '>') {
        // 引用块懒延续（对齐 Lute）：非空行只要不是块起始形态就并入引用
        while (i < L.length && L[i].trim() !== '') {
          if (i > 0 && L[i].trim().charAt(0) !== '>' && isBlockStart(L[i].trim())) break;
          i++;
        }
      } else if (R_LI.test(tr) || R_OL.test(tr)) {
        var listKind = R_LI.test(tr) ? 'ul' : 'ol';
        var listFirst = i;
        while (i < L.length) {
          if (L[i].trim() === '') {
            var nx = i + 1;
            while (nx < L.length && L[nx].trim() === '') nx++;
            if (nx < L.length) {
              // 空行后：同类型列表标记（loose list，Lute 渲染单块）或缩进
              // 续行（lazy continuation）才属于本块；异类型列表是独立块
              var nt = L[nx].trim();
              var continueList = (R_LI.test(nt) && listKind === 'ul')
                || (R_OL.test(nt) && listKind === 'ol')
                || R_INDENT.test(L[nx]);
              if (continueList) {
                i = nx;
              } else {
                break;
              }
            } else {
              break;
            }
          } else if (i > listFirst && isListBreakingBlockStart(L[i])) {
            // 列表行后无空行紧跟的顶格块起始形态：Lute 分块（实测
            // heading/quote/fence/hr 断开），缩进续行、表格行与普通
            // 文本并入列表
            break;
          } else {
            i++;
          }
        }
      } else {
        i++;
        while (i < L.length && L[i].trim() !== '') {
          // 原文可用 --- 下划线标题；不能将下划线误当独立分隔线。
          if (R_SETEXT.test(L[i].trim())) { i++; break; }
          if (isBlockStart(L[i].trim())) break;
          i++;
        }
      }
    }
    return starts;
  }

  // ── DOM binding ──────────────────────────────────────────────────────────

  var BLOCK_TAGS = {
    P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    UL: 1, OL: 1, BLOCKQUOTE: 1, TABLE: 1, PRE: 1, HR: 1,
  };

  function isEmptyParagraph(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) {
        if (n.textContent.replace(/[\u200b\n\r\t ]/g, '')) return false;
      } else if (n.nodeType === 1) {
        var t = n.tagName;
        if (t === 'BR' || t === 'WBR') continue;
        return false;
      }
    }
    return true;
  }

  function isNumberableBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    if (BLOCK_TAGS[el.tagName]) {
      if (el.tagName === 'P' && isEmptyParagraph(el)) return false;
      return true;
    }
    // Lute content wrappers: code-block, yaml-front-matter,
    // footnotes-block, link-ref-defs-block, toc …
    if (el.tagName === 'DIV' && el.getAttribute('data-type')) return true;
    return false;
  }

  /** 活动模式（ir/wysiwyg）的编辑面；sv 无块级编辑面，返回 null */
  function activeReset() {
    var v = currentEditor && currentEditor.vditor;
    if (!v || (v.currentMode !== 'ir' && v.currentMode !== 'wysiwyg')) return null;
    var host = v[v.currentMode] && v[v.currentMode].element;
    if (!host) return null;
    if (host.classList.contains('vditor-reset')) return host;
    return host.querySelector('.vditor-reset');
  }

  function clearNumbers() {
    var marked = document.querySelectorAll('[' + ATTR + ']');
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute(ATTR);
      marked[i].style.removeProperty('--lineno');
      marked[i].style.removeProperty('--lineno-offset');
    }
    watchParagraphSizes([]);
  }

  // Lute omits leading blank lines from a paragraph's source block, but the live
  // DOM retains them while editing. Keep its number beside the first content line.
  function paragraphLeadingBreaks(paragraph) {
    var walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var count = 0;
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) {
        var prefix = node.textContent.match(/^[\s\u200b]*/)[0];
        count += (prefix.match(/\n/g) || []).length;
        if (prefix.length < node.textContent.length) break;
      } else if (node.tagName === 'BR') {
        count++;
      } else if (node.tagName === 'IMG' || node.tagName === 'SVG' ||
          node.getAttribute('contenteditable') === 'false') {
        break;
      }
    }
    return count;
  }

  function watchParagraphSizes(paragraphs) {
    if (typeof ResizeObserver === 'undefined') return;
    if (!paragraphResizeObserver && paragraphs.length) {
      paragraphResizeObserver = new ResizeObserver(scheduleSync);
    }
    if (!paragraphResizeObserver) return;
    watchedParagraphs.forEach(function (paragraph) {
      if (paragraphs.indexOf(paragraph) < 0) paragraphResizeObserver.unobserve(paragraph);
    });
    paragraphs.forEach(function (paragraph) {
      if (watchedParagraphs.indexOf(paragraph) < 0) paragraphResizeObserver.observe(paragraph);
    });
    watchedParagraphs = paragraphs;
  }

  function sync() {
    if (!currentEditor || !enabled) return;
    var reset = activeReset();
    if (!reset) return;

    var blocks = [];
    for (var j = 0; j < reset.children.length; j++) {
      if (isNumberableBlock(reset.children[j])) blocks.push(reset.children[j]);
    }

    var starts = null;
    try {
      if (sourceText !== null) {
        starts = computeBlockStarts(sourceText === undefined ? currentEditor.getValue() || '' : sourceText);
      }
    } catch (e) {
      starts = null;
    }

    // 映射安全防线：块数与起点数不一致说明扫描器与 Lute 解析分叉
    // （html 块、footnote 聚合等），按序 1:1 映射会静默错号——全部不编号
    if (!starts || starts.length !== blocks.length) {
      var staleAll = reset.querySelectorAll('[' + ATTR + ']');
      for (var s = 0; s < staleAll.length; s++) {
        staleAll[s].removeAttribute(ATTR);
        staleAll[s].style.removeProperty('--lineno');
        staleAll[s].style.removeProperty('--lineno-offset');
      }
      watchParagraphSizes([]);
      return;
    }

    var leadingParagraphs = [];
    for (var k = 0; k < blocks.length; k++) {
      var val = String(starts[k]);
      if (blocks[k].getAttribute(ATTR) !== val) {
        blocks[k].setAttribute(ATTR, val);
        // CSS 变量随属性同源：table 的行号锚在 th 上，attr() 无法跨元素，
        // 靠继承的 --lineno 取值（见 index.css）。值必须带引号——裸数字
        // token 会让 content: var(--lineno) 替换成 content: 23 而整条失效
        blocks[k].style.setProperty('--lineno', '"' + val + '"');
      }
      var leading = blocks[k].tagName === 'P' ? paragraphLeadingBreaks(blocks[k]) : 0;
      if (leading) {
        var lineHeight = parseFloat(getComputedStyle(blocks[k]).lineHeight);
        leadingParagraphs.push(blocks[k]);
        if (Number.isFinite(lineHeight)) {
          blocks[k].style.setProperty('--lineno-offset', (leading * lineHeight) + 'px');
        } else {
          blocks[k].style.removeProperty('--lineno-offset');
        }
      } else {
        blocks[k].style.removeProperty('--lineno-offset');
      }
    }
    watchParagraphSizes(leadingParagraphs);
    // 块退化为不可编号形态（如变空 p）时清掉过期行号
    var stale = reset.querySelectorAll('[' + ATTR + ']');
    for (var m = 0; m < stale.length; m++) {
      if (blocks.indexOf(stale[m]) < 0) {
        stale[m].removeAttribute(ATTR);
        stale[m].style.removeProperty('--lineno');
        stale[m].style.removeProperty('--lineno-offset');
      }
    }
  }

  function scheduleSync() {
    if (scheduled || !enabled || !currentEditor) return;
    scheduled = true;
    var raf = window.requestAnimationFrame || function (f) { setTimeout(f, 16); };
    raf(function () {
      scheduled = false;
      sync();
    });
  }

  function watch() {
    if (observer || !currentEditor) return;
    observer = new MutationObserver(scheduleSync);
    // 观察编辑器根（模式切换换容器、IR spin 换块都在子树内）；
    // 只看 childList/characterData——自身写 data-lineno 属性不会自触发
    var root = (currentEditor.vditor && currentEditor.vditor.element) || document.body;
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function applyBodyClasses() {
    document.body.classList.toggle(ON_CLASS, enabled);
    document.body.classList.toggle(OFF_CLASS, !enabled);
  }

  // ── public API ───────────────────────────────────────────────────────────

  function setSource(text) {
    sourceText = typeof text === 'string' ? text : null;
    sync();
  }

  function setEnabled(on) {
    enabled = !!on;
    applyBodyClasses();
    if (!enabled) {
      if (observer) { observer.disconnect(); observer = null; }
      clearNumbers();
      return;
    }
    watch();
    sync();
  }

  function install(editor, options) {
    if (!editor) return;
    if (currentEditor === editor) { sync(); return; }
    // 换编辑器实例时旧 observer 仍观察旧根，先断开（防御：当前接线
    // 每 webview 仅 install 一次，不触发；保持模块可安全复用）
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    watchParagraphSizes([]);
    currentEditor = editor;
    sourceText = options && options.sourceText;
    enabled = options && options.enabled !== undefined ? !!options.enabled : true;
    setEnabled(enabled);
  }

  window.BlockLineNumbers = {
    install: install,
    setEnabled: setEnabled,
    setSource: setSource,
    sync: sync,
    computeBlockStarts: computeBlockStarts,
  };
})();
