/**
 * Block line numbers — source start line per top-level block (IR & WYSIWYG).
 *
 * Ported from vscode-markdown-editor-hardened `src/extension.ts`
 * lineNumberScript (d64e408; upstream PR #157 by asalcedo29). The scanner
 * semantics are kept verbatim where marked; the display and DOM-binding
 * layers are this fork's own (see "Intentional divergences" below).
 *
 * What the user sees: every independent paragraph/block (h1-h6, p, ul/ol,
 * blockquote, table, code block, frontmatter …) carries the 1-based line
 * its first source line occupies in the editor's CURRENT text (live
 * getValue(), not the startup snapshot — the snapshot drifts as soon as
 * the document is edited). vditor re-serializes blank lines, so numbers
 * may differ from the file on disk by a few lines (upstream-documented
 * behavior, mirrored in the setting description).
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
 *   - setext headings ("para" + "---"), html comments, 4+ backtick
 *     fences are not recognized
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
  var enabled = true;
  var observer = null;
  var scheduled = false;

  // ── block scanner ────────────────────────────────────────────────────────

  var R_HEADING = /^#{1,6} /;
  var R_HR = /^(---|[*]{3}|___)$/;
  var R_LI = /^[-*+] /;
  var R_OL = /^[0-9]+[.)] /;
  // 懒延续缩进行：空格或 Tab（编辑器 Tab 键即插入 \t，见 index.js tab:'\t'）
  var R_INDENT = /^[\t ]+\S/;
  var FENCE = '```';

  function isBlockStart(s) {
    return R_HEADING.test(s) || R_LI.test(s) || R_OL.test(s)
      || s.indexOf(FENCE) === 0 || s.indexOf('$$') === 0
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
      || s.indexOf(FENCE) === 0 || s.indexOf('$$') === 0 || R_HR.test(s);
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
      } else if (tr.indexOf(FENCE) === 0 || tr.indexOf('$$') === 0) {
        // fence / 数学块：单行自闭合（$$..$$ 同行闭合）只占一行，
        // 否则吞到闭合行（$$ 或 ```）或 EOF
        if (tr.indexOf('$$') === 0 && tr.length > 4 && tr.lastIndexOf('$$') > 0) {
          i++;
        } else {
          var closer = tr.indexOf(FENCE) === 0 ? FENCE : '$$';
          i++;
          while (i < L.length && L[i].trim().indexOf(closer) !== 0) i++;
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
    }
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
      starts = computeBlockStarts(currentEditor.getValue() || '');
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
      }
      return;
    }

    for (var k = 0; k < blocks.length; k++) {
      var val = String(starts[k]);
      if (blocks[k].getAttribute(ATTR) !== val) {
        blocks[k].setAttribute(ATTR, val);
        // CSS 变量随属性同源：table 的行号锚在 th 上，attr() 无法跨元素，
        // 靠继承的 --lineno 取值（见 index.css）。值必须带引号——裸数字
        // token 会让 content: var(--lineno) 替换成 content: 23 而整条失效
        blocks[k].style.setProperty('--lineno', '"' + val + '"');
      }
    }
    // 块退化为不可编号形态（如变空 p）时清掉过期行号
    var stale = reset.querySelectorAll('[' + ATTR + ']');
    for (var m = 0; m < stale.length; m++) {
      if (blocks.indexOf(stale[m]) < 0) {
        stale[m].removeAttribute(ATTR);
        stale[m].style.removeProperty('--lineno');
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
    currentEditor = editor;
    enabled = options && options.enabled !== undefined ? !!options.enabled : true;
    setEnabled(enabled);
  }

  window.BlockLineNumbers = {
    install: install,
    setEnabled: setEnabled,
    sync: sync,
    computeBlockStarts: computeBlockStarts,
  };
})();
