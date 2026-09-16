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
 * Known limitations shared with the source (documented, not fixed):
 *   - html blocks and footnote-definition sections scan as ordinary
 *     paragraph lines (they usually align by accident)
 *   - two lists separated only by a blank line merge into one numbered
 *     block (lazy-continuation looseness)
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
  var R_INDENT = /^ +[^ ]/;
  var FENCE = '```';

  function isBlockStart(s) {
    return R_HEADING.test(s) || R_LI.test(s) || R_OL.test(s)
      || s.indexOf(FENCE) === 0 || s.charAt(0) === '|' || s.charAt(0) === '>'
      || R_HR.test(s);
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
      } else if (tr.indexOf(FENCE) === 0) {
        i++;
        while (i < L.length && L[i].trim().indexOf(FENCE) !== 0) i++;
        if (i < L.length) i++;
      } else if (tr.charAt(0) === '|') {
        while (i < L.length && L[i].trim().charAt(0) === '|') i++;
      } else if (tr.charAt(0) === '>') {
        while (i < L.length && L[i].trim() !== '' && L[i].trimStart().charAt(0) === '>') i++;
      } else if (R_LI.test(tr) || R_OL.test(tr)) {
        var listKind = R_LI.test(tr) ? 'ul' : 'ol';
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
      starts = null; // 回退块序号，永不显示错行号
    }

    for (var k = 0; k < blocks.length; k++) {
      var n = starts && k < starts.length ? starts[k] : (k + 1);
      var val = String(n);
      if (blocks[k].getAttribute(ATTR) !== val) {
        blocks[k].setAttribute(ATTR, val);
        // CSS 变量随属性同源：table 的行号锚在 th 上，attr() 无法跨元素，
        // 靠继承的 --lineno 取值（见 index.css）。值必须带引号——裸数字
        // token 会让 content: var(--lineno) 替换成 content: 23 而整条失效
        blocks[k].style.setProperty('--lineno', '"' + val + '"');
      }
    }
    // 块数多于 starts（或块退化为不可编号形态）时清掉过期行号
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
