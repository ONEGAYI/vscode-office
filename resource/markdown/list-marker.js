/**
 * Live list markers (Obsidian-style focus editing) for WYSIWYG and IR modes.
 *
 * Ported from vscode-markdown-editor-hardened `media-src/src/list-marker.ts`
 * (fork issue #1; IR support added in fork issue #12 — the two modes share
 * the same list DOM model, see test/webview/list-marker.test.js IL group).
 * Rendering state: vditor draws ordered/unordered markers via the browser's
 * native list rendering, so the numbers/bullets are invisible to the caret —
 * there is no way to edit "1." into "5.". This module makes the marker of
 * the caret's list line a REAL text node while that line is focused:
 *
 *   <li data-marker="1." class="vmd-marker-live">
 *     <span class="vmd-li-marker">1.&nbsp;</span>first
 *   </li>
 *
 * and swaps back to the CSS-rendered marker (::before with attr(data-marker),
 * see index.css) as soon as the caret leaves the line.
 *
 * Hard constraint (probed on this fork's Lute, both SpinVditorDOM and
 * SpinVditorIRDOM): marker-looking text inside a li ("5. ", "- ") never
 * survives as markup — the engine strips the span and glues its text into
 * the li content. So the span must never be part of any HTML handed to
 * Lute. Two defenses make that impossible:
 *   - SpinVditorDOM / SpinVditorIRDOM / VditorDOM2Md are wrapped
 *     (monkey-patched on vditor.vditor.lute) to strip every marker span out
 *     of the input and fold its value into the li/ol data-marker (+ol start)
 *     attributes first.
 *   - the span is proactively removed (value folded into attributes) before
 *     we hand control back to vditor's own input pipeline.
 *
 * Lute's marker authority rules (fenced by test/webview/list-marker.test.js
 * L1-L5 / IL0-IL6): ordered numbering follows the OL's data-marker/start (so
 * the first li's edit must sync the ol), unordered follows the FIRST li's
 * data-marker (spin follows it by itself). Emptying the marker lifts the li
 * out of the list into a paragraph.
 *
 * Wiring (see resource/markdown/index.html + index.js):
 *   <script src="list-marker.js"></script>  then  ListMarkerLive.install(editor)
 *
 * Intentional divergences from the hardened source (fixes for defects the
 * source also carries — keep in sync when porting back):
 *   - Enter/Space intercept requires the caret INSIDE the marker span
 *     (`span`), not merely a live span on the line (`liSpan`): ensureLive
 *     keeps a span on the focused line even when the caret is in the item
 *     content, so line-level interception permanently swallowed content
 *     spaces/enters.
 *   - isComposing guard on both capture handlers (IME sessions must never
 *     be intercepted; matches vditor's own processKeydown guard).
 *   - char-by-char Backspace down to empty marker text lifts the item
 *     directly (the emptied span has no text node to place the caret in;
 *     the source threw TypeError there). The outer guard is also tightened
 *     to `span && liSpan` (defensive; behaviorally equivalent).
 *   - task-list items (li.vditor-task) never activate (fork's task li
 *     carries data-marker and couples with the checkbox layout).
 *
 * Known limitations shared with the source (documented, not fixed):
 *   - single-char input inside the span commits immediately, so the
 *     delete-then-type path for multi-digit markers truncates (type the
 *     digits before the delimiter instead: "1." → "10." works, deleting
 *     down to "1" then typing "0." loses the input).
 *   - text pasted into the marker span that fails parseMarker is silently
 *     dropped (the marker keeps its previous value).
 *   - the first marker edit right after document load (~undoDelay, before
 *     the boot snapshot lands on the undo stack) is not undoable: it clears
 *     the pending boot-snapshot push and never captures a restorable
 *     pre-edit snapshot (its own debounced push becomes stack entry #1),
 *     so undo (needs ≥2 entries) stays a no-op. Same in both modes; the
 *     window closes once the boot snapshot lands.
 */
(function () {
  'use strict';

  var SPAN_CLASS = 'vmd-li-marker';
  var LI_LIVE_CLASS = 'vmd-marker-live';
  var WRAP_FLAG = '__vmdListMarkerWrapped';

  /** 当前面板的编辑器实例（每个 webview 面板仅一个，after() 时安装） */
  var currentEditor = null;

  /** 当前模式（wysiwyg/ir）的编辑面：两模式共用 listToggle 与同一套列表
   *  DOM/属性模型（IL0），marker 编辑在 ir 下同样生效（#12） */
  function editorEl() {
    var v = currentEditor && currentEditor.vditor;
    if (!v || (v.currentMode !== 'wysiwyg' && v.currentMode !== 'ir')) return null;
    return v[v.currentMode] ? v[v.currentMode].element : null;
  }

  function inEditorMode() {
    return !!(currentEditor && currentEditor.vditor
      && editorEl());
  }

  /** Marker validity per list type; null = keep the li's current data-marker. */
  function parseMarker(raw, li) {
    var parent = li.parentElement;
    var trimmed = raw.replace(/\u00A0/g, ' ').trim();
    if (parent && parent.tagName === 'OL') {
      return /^\d{1,9}[.)]$/.test(trimmed) ? trimmed : null;
    }
    return /^[-*+]$/.test(trimmed) ? trimmed : null;
  }

  /**
   * Write a (valid) marker text into the li's data-marker, syncing the parent
   * list's own attributes for FIRST items: ordered numbering is authoritative
   * on the ol (data-marker + start), unordered spin follows the first li.
   */
  function applyMarker(li, raw) {
    var marker = parseMarker(raw, li);
    if (!marker) return false;
    li.setAttribute('data-marker', marker);
    var parent = li.parentElement;
    if (parent && parent.firstElementChild === li
      && (parent.tagName === 'OL' || parent.tagName === 'UL')) {
      parent.setAttribute('data-marker', marker);
      if (parent.tagName === 'OL') {
        var n = parseInt(marker, 10);
        if (!isNaN(n)) parent.setAttribute('start', String(n));
      }
    }
    return true;
  }

  // ── span lifecycle ────────────────────────────────────────────────────────

  function liveSpanOf(li) {
    return li.querySelector(':scope > span.' + SPAN_CLASS);
  }

  /** True when the li has any text of its own besides a possible live span. */
  function hasOwnContent(li) {
    var walker = li.ownerDocument.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = walker.nextNode())) {
      if (n.parentElement && n.parentElement.closest('.' + SPAN_CLASS)) continue;
      if ((n.textContent || '').length > 0) return true;
    }
    return false;
  }

  function ensureLive(li) {
    if (liveSpanOf(li)) return;
    // An item with no content text must NOT get a span: it would be the li's
    // only child, and the browser normalizes any caret inside the li into
    // the span text — typing would land in the marker (swallowed by the
    // input gate) and Backspace would edit the marker char-by-char instead
    // of deleting the empty item. Keep vditor's native empty-item paths.
    if (!hasOwnContent(li)) return;
    var marker = li.getAttribute('data-marker') || '';
    var span = document.createElement('span');
    span.className = SPAN_CLASS;
    span.textContent = marker + '\u00A0';
    // A caret parked at (li, 0) — e.g. a click on the line start of an item
    // whose first child is a block wrapper — would end up BEFORE the injected
    // span (the marker), visually jumping to the marker's first character.
    // Nudge it past the span (the content start) instead.
    var sel = document.getSelection();
    var caretAtLiStart = sel && sel.rangeCount > 0
      && sel.anchorNode === li && sel.anchorOffset === 0;
    li.insertBefore(span, li.firstChild);
    li.classList.add(LI_LIVE_CLASS);
    if (caretAtLiStart) {
      var range = document.createRange();
      range.setStart(li, 1);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /**
   * Remove the live span. If the caret currently sits inside the span, move it
   * to the start of the li's real content first — removing a node that holds
   * the selection anchor leaves a detached range, which re-triggers
   * selectionchange and can loop.
   */
  function clearLive(li) {
    var span = liveSpanOf(li);
    if (!span) return;
    var sel = document.getSelection();
    if (sel && sel.rangeCount > 0) {
      var node = sel.anchorNode;
      if (node && (node === span || span.contains(node))) {
        var next = contentStart(li);
        var range = document.createRange();
        range.setStart(next.node, next.offset);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    span.remove();
    li.classList.remove(LI_LIVE_CLASS);
  }

  /** First caret position of the li's own content (after any live span). */
  function contentStart(li) {
    var node = li.firstChild;
    while (node && !(node.nodeType === 3)) {
      if (node.nodeType === 1) {
        var el = node;
        if (el.classList && el.classList.contains(SPAN_CLASS)) {
          node = node.nextSibling;
          continue;
        }
        // block wrapper (loose list: li > p)
        node = node.firstChild;
        continue;
      }
      node = node.nextSibling;
    }
    if (!node) return { node: li, offset: 0 };
    return { node: node, offset: 0 };
  }

  function closestLi(node) {
    if (!node) return null;
    var el = node.nodeType === 3 ? node.parentElement : node;
    while (el && el.tagName !== 'LI') el = el.parentElement;
    if (!el || !el.hasAttribute('data-marker')) return null;
    // 任务列表项的 data-marker 与 checkbox 布局耦合，marker 编辑明确不做：
    // 拒绝激活，让模块完全不干预任务行
    if (el.classList.contains('vditor-task')) return null;
    var editor = editorEl();
    if (!editor || !editor.contains(el)) return null;
    return el;
  }

  function caretSpan() {
    var sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    var node = sel.anchorNode;
    if (!node) return null;
    var el = node.nodeType === 3 ? node.parentElement : node;
    while (el) {
      if (el.classList && el.classList.contains(SPAN_CLASS)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function onSelectionChange() {
    if (!inEditorMode()) return;
    var editor = editorEl();

    var sel = document.getSelection();
    var activeLi = (sel && sel.rangeCount > 0) ? closestLi(sel.anchorNode) : null;

    // Remove every stale span (previous line, undo-restored snapshots, …) —
    // but never the active line's: wiping it would reset marker text the user
    // is mid-edit on.
    editor.querySelectorAll('.' + SPAN_CLASS).forEach(function (span) {
      var li = span.closest('li');
      if (li && li === activeLi) return;
      if (li) clearLive(li);
      else span.remove();
    });

    if (activeLi) ensureLive(activeLi);
  }

  // ── marker commit (span → attributes → vditor pipeline) ──────────────────

  /**
   * Commit the span's current text: fold it into data-marker attributes,
   * remove the span (caret lands on a <wbr> at the li's content start), then
   * re-dispatch a clean input event so vditor re-spins the list and the undo
   * stack records the change through its normal pipeline.
   */
  function commitSpan(span) {
    var li = span.closest('li');
    if (!li) return;
    applyMarker(li, span.textContent || '');

    var pos = contentStart(li);
    var wbr = document.createElement('wbr');
    if (pos.node.nodeType === 3) pos.node.parentNode.insertBefore(wbr, pos.node);
    else pos.node.insertBefore(wbr, pos.node.firstChild);

    var sel = document.getSelection();
    var range = document.createRange();
    range.setStartBefore(wbr);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    span.remove();
    li.classList.remove(LI_LIVE_CLASS);

    var editor = editorEl();
    if (editor) {
      editor.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: ' ',
      }));
    }
  }

  /** Lift a li out of its list into a paragraph at the same position. */
  function liftOutOfList(li) {
    var editor = editorEl();
    if (!editor) return;
    var span = liveSpanOf(li);
    if (span) span.remove();

    var p = document.createElement('p');
    p.setAttribute('data-block', '0');
    while (li.firstChild) p.appendChild(li.firstChild);
    var wbr = document.createElement('wbr');
    p.insertBefore(wbr, p.firstChild);
    // p 必须落在列表外：ul/ol 的直接 p 子元素是无效结构，ir 的 Lute 会
    // 把它解析成上一项的懒续行（"- alpha\n  beta"）。唯一项时整个列表
    // 换成段落；多项时 p 放列表尾之后（中间项升格后位置后移——已知
    // 限制，与 wysiwyg 共享此行为）
    var list = li.parentElement;
    if (list && (list.tagName === 'UL' || list.tagName === 'OL')) {
      if (list.children.length === 1) {
        list.replaceWith(p);
      } else {
        list.insertAdjacentElement('afterend', p);
        li.remove();
      }
    } else {
      li.replaceWith(p);
    }

    var sel = document.getSelection();
    var range = document.createRange();
    range.setStartBefore(wbr);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertText', data: ' ',
    }));
  }

  function spanMarkerText(span) {
    return (span.textContent || '').replace(/\u00A0/g, ' ').trim();
  }

  // ── input / keydown interception ─────────────────────────────────────────

  function onInputCapture(event) {
    // IME composition 期间不拦截：拦截会销毁 composition 会话（丢字/错位）
    if (event.isComposing) return;
    if (!inEditorMode()) return;
    var span = caretSpan();
    if (!span) return;
    // Caret is inside the marker span: swallow this event (vditor's handler
    // would see the span text as li content) and commit through our pipeline.
    event.stopPropagation();
    var li = span.closest('li');
    if (li && spanMarkerText(span) === '') {
      liftOutOfList(li);
      return;
    }
    commitSpan(span);
  }

  function onKeydownCapture(event) {
    // IME composition 期间不拦截（含候选确认的 Enter），与 fork 自身
    // processKeydown 的 isComposing 防护同级
    if (event.isComposing) return;
    if (!inEditorMode()) return;
    var sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    var span = caretSpan();
    var li = span ? span.closest('li') : closestLi(sel.anchorNode);
    if (!li) return;
    var liSpan = liveSpanOf(li);

    if (event.key === 'Enter' || event.key === ' ') {
      // 仅当光标在 marker span 内才拦截提交。行上有 span 不足以拦截：
      // 光标在列表行正文内时 span 恒存在（ensureLive 无条件建），
      // 按行拦截会把正文里的空格/Enter 永久吞掉
      if (span) {
        event.preventDefault();
        event.stopPropagation();
        commitSpan(span);
      }
      return;
    }

    if (event.key === 'Backspace') {
      if (liSpan && spanMarkerText(liSpan) === '') {
        // marker already emptied → leave the list
        event.preventDefault();
        event.stopPropagation();
        liftOutOfList(li);
        return;
      }
      if (span && liSpan) {
        // caret inside the span: delete the marker char before the caret
        // ourselves (jsdom performs no default editing; real browsers are
        // blocked via preventDefault so the deletion happens exactly once)
        event.preventDefault();
        event.stopPropagation();
        var text = liSpan.textContent || '';
        var node = sel.anchorNode;
        var offset = (node === liSpan || (node && liSpan.contains(node)))
          ? sel.anchorOffset : text.length;
        var pos = Math.max(0, Math.min(offset, text.length));
        if (pos > 0) {
          var next = text.slice(0, pos - 1) + text.slice(pos);
          liSpan.textContent = next;
          if (spanMarkerText(liSpan) === '') {
            // span 文本删空后文本节点消失，无法再定位光标——直接升格
            // （liftOutOfList 自行设置光标）
            liftOutOfList(li);
            return;
          }
          var caretNode = liSpan.firstChild;
          var range = document.createRange();
          range.setStart(caretNode, Math.max(0, pos - 1));
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return;
      }
      return;
    }

    if (event.key === 'Tab' && liSpan) {
      // give vditor's indent logic a clean DOM (no span): commit first, then
      // let the event continue to vditor's own keydown handling
      commitSpan(liSpan);
    }
  }

  // ── Lute gate ────────────────────────────────────────────────────────────

  /**
   * Strip every marker span from an HTML string, folding each span's text into
   * the li/ol attributes first. Used on all HTML bound for Lute so the span
   * can never reach the parser (its text would be glued into the li content).
   */
  function stripMarkerSpans(html) {
    if (html.indexOf(SPAN_CLASS) === -1) return html;
    var doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('.' + SPAN_CLASS).forEach(function (span) {
      var li = span.closest('li');
      if (li) applyMarker(li, span.textContent || '');
      span.remove();
    });
    return doc.body.innerHTML;
  }

  function wrapLute() {
    var lute = currentEditor && currentEditor.vditor && currentEditor.vditor.lute;
    if (!lute || lute[WRAP_FLAG]) return;
    // VditorIRDOM2Md 不能少：ir 的 getValue（getMarkdown）走它序列化，
    // 缺了这条门 span 会直接进 Lute、文本被粘进 li 内容（#12）。
    // 三个 HTML 方法是纵深防御：getHTML 的导出路径（2HTML）实测输出
    // 本就干净（Lute 把 span 文本折叠回 marker 语义），粘贴回灌入口
    // （HTML2VditorIRDOM）的折叠光标复制场景 jsdom 无法坐实——统一
    // 过门保证任何携带 span 的 HTML 进 Lute 前都被剥离
    var methods = ['SpinVditorDOM', 'SpinVditorIRDOM', 'VditorDOM2Md', 'VditorIRDOM2Md',
      'VditorDOM2HTML', 'VditorIRDOM2HTML', 'HTML2VditorDOM', 'HTML2VditorIRDOM'];
    for (var i = 0; i < methods.length; i++) {
      (function (name) {
        var orig = lute[name];
        if (typeof orig !== 'function') return;
        lute[name] = function (html) {
          return orig.call(this, typeof html === 'string' ? stripMarkerSpans(html) : html);
        };
      })(methods[i]);
    }
    lute[WRAP_FLAG] = true;
  }

  // ── install ──────────────────────────────────────────────────────────────

  /**
   * Idempotent installer, called from index.js after() on every (re)build.
   * The document-level listeners are installed once; the lute wrapper must be
   * re-attached per build because a vditor destroy/re-init creates a fresh
   * lute instance.
   */
  function install(editor) {
    currentEditor = editor;
    if (!window.__vmdListMarkerInstalled) {
      window.__vmdListMarkerInstalled = true;
      document.addEventListener('selectionchange', onSelectionChange, false);
      document.addEventListener('input', onInputCapture, true);
      document.addEventListener('keydown', onKeydownCapture, true);
    }
    wrapLute();
  }

  window.ListMarkerLive = { install: install };
})();
