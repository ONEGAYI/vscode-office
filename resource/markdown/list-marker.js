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
 *   - marker edits commit DEFERRED, not per keystroke: input inside the span
 *     is only swallowed. Enter/Space/Tab commit explicitly (full pipeline:
 *     undo record + re-spin), the caret leaving the span folds the text into
 *     the list attributes silently (foldLive — first items only, whole-list
 *     attribute sync, host save reported via options.input, no re-spin, no
 *     undo record), Escape drops the edit. The source committed on every
 *     keystroke, so any multi-char edit broke after its first char (the
 *     span vanished; the second char hit the content or failed parseMarker
 *     and disappeared).
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
 *   - text pasted into the marker span that fails parseMarker is silently
 *     dropped when the edit folds (the marker keeps its previous value).
 *   - fold commits (caret leaving the span) bypass the undo stack: Ctrl+Z
 *     cannot revert a marker edit that was committed by clicking away —
 *     Enter/Space/Tab is the only recording commit path.
 *   - full-document redraws (setValue / external-change reload / AI
 *     applyAIResult) drop an unsubmitted in-span marker edit together with
 *     the span itself.
 *   - undo debounce race: a pending recordHistory timer from an edit made
 *     just before a marker session can capture the DOM mid-edit (span with
 *     half-typed text). Restoring such a snapshot and then clicking away
 *     folds (commits) the half-typed marker instead of discarding it, so
 *     one undo step may not fully revert. Narrow window, data is never
 *     lost; re-undoing reaches the earlier snapshot.
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

  /** Last left-button mousedown point, for restoring the precise caret on
   * first-time marker activation (see ensureLive). Consumed once. */
  var lastMarkerClick = null;

  function onMouseDownCapture(event) {
    if (!inEditorMode()) return;
    lastMarkerClick = null;
    if (event.button !== 0 || event.shiftKey) return;
    var li = closestLi(event.target);
    if (li && liveSpanOf(li)) return;
    lastMarkerClick = { x: event.clientX, y: event.clientY, t: Date.now(), li: li };
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
    // A CSS marker click can normalize to the first CONTENT text node, not
    // just (li, 0). Resolve a fresh click on this item against the injected
    // span in either case. A body click must retain its native selection.
    var sel = document.getSelection();
    var caretAtLiStart = sel && sel.rangeCount > 0
      && sel.anchorNode === li && sel.anchorOffset === 0;
    li.insertBefore(span, li.firstChild);
    li.classList.add(LI_LIVE_CLASS);
    var pt = lastMarkerClick;
    lastMarkerClick = null;
    if (caretAtLiStart || (pt && pt.li === li && sel && sel.isCollapsed)) {
      var placed = false;
      if (pt && Date.now() - pt.t < 600) {
        var doc = li.ownerDocument;
        var pos = null;
        if (typeof doc.caretPositionFromPoint === 'function') {
          var p = doc.caretPositionFromPoint(pt.x, pt.y);
          if (p) pos = { node: p.offsetNode, offset: p.offset };
        } else if (typeof doc.caretRangeFromPoint === 'function') {
          var r = doc.caretRangeFromPoint(pt.x, pt.y);
          if (r) pos = { node: r.startContainer, offset: r.startOffset };
        }
        if (pos && pos.node && span.contains(pos.node)) {
          var hit = document.createRange();
          hit.setStart(pos.node, pos.offset);
          hit.collapse(true);
          sel.removeAllRanges();
          sel.addRange(hit);
          placed = true;
        }
      }
      if (!placed && caretAtLiStart) {
        var range = document.createRange();
        range.setStart(li, 1);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  /**
   * Move the caret out of the span to the start of the li's real content —
   * if it currently sits inside the span. Removing a node that holds the
   * selection anchor leaves a detached range, which re-triggers
   * selectionchange and can loop. Selection is left alone otherwise.
   */
  function moveCaretOutOfSpan(span, li) {
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
  }

  /**
   * Drop the live span WITHOUT committing: the edited marker text is
   * discarded and the CSS-rendered marker (previous data-marker) is
   * restored. Escape key path — the user explicitly abandoned the edit.
   */
  function clearLive(li) {
    var span = liveSpanOf(li);
    if (!span) return;
    moveCaretOutOfSpan(span, li);
    span.remove();
    li.classList.remove(LI_LIVE_CLASS);
  }

  /**
   * Fold the live span's text into the list's marker attributes and swap
   * back to the CSS-rendered marker. This is the silent commit for "caret
   * left the span" (clicked into the content, or onto another line): an
   * invalid mid-edit text (e.g. ".") keeps the previous marker — a silent
   * revert, same fallback the Lute gate applies. No input event is
   * dispatched and the selection is not touched beyond moving it out of
   * the span: re-spinning the DOM inside selectionchange would steal the
   * caret the user just placed elsewhere (see applyFirstMarker for the
   * first-item-only rule and notifySaved for the host save report).
   */
  function foldLive(li) {
    var span = liveSpanOf(li);
    if (!span) return;
    var text = span.textContent || '';
    moveCaretOutOfSpan(span, li);
    if (applyFirstMarker(li, text)) notifySaved();
    span.remove();
    li.classList.remove(LI_LIVE_CLASS);
  }

  /**
   * Fold-path marker write: FIRST items only, syncing the whole list's
   * data-marker attributes. Lute's numbering authority is the ol start /
   * the first li's data-marker: a middle item's hand-edited marker is
   * rewritten back to sequential numbering on the next spin (ordered) or
   * splits the list (unordered), so writing it would only defer the
   * surprise — refusing keeps the fold channel observably identical to
   * the Enter channel (the edit simply does not take effect). Writing the
   * first item re-syncs every li so getValue serializes the renumbered
   * markdown immediately (the Enter channel gets this from the spin; the
   * fold must do it by hand). Returns true when the marker was written.
   */
  function applyFirstMarker(li, raw) {
    var parent = li.parentElement;
    if (!parent || (parent.tagName !== 'OL' && parent.tagName !== 'UL')) return false;
    if (parent.firstElementChild !== li) return false;
    var marker = parseMarker(raw, li);
    if (!marker) return false;
    li.setAttribute('data-marker', marker);
    parent.setAttribute('data-marker', marker);
    if (parent.tagName === 'OL') {
      var n = parseInt(marker, 10);
      if (isNaN(n)) return true;
      parent.setAttribute('start', String(n));
      var delim = marker.slice(-1);
      for (var i = 1; i < parent.children.length; i++) {
        parent.children[i].setAttribute('data-marker', String(n + i) + delim);
      }
    } else {
      for (var j = 1; j < parent.children.length; j++) {
        parent.children[j].setAttribute('data-marker', marker);
      }
    }
    return true;
  }

  /**
   * Report a committed marker edit to the host save pipeline. The host
   * only hears about edits through vditor's options.input callback
   * (webview index.js → emit("save") → scheduleDocumentSync): without it
   * the document stays clean and Ctrl+S / panel close silently lose the
   * edit. The DOM input event is deliberately NOT dispatched (the spin
   * would steal the caret); the attributes are already final, so the
   * serialized value is reported as-is. Undo is not recorded (Known
   * limitations).
   *
   * Object model: install() receives the Vditor instance itself (index.js
   * `editor = new Vditor(...)`), so getValue() lives on currentEditor
   * while options.input lives on the inner IVditor (currentEditor.vditor)
   * — the same split editorEl() relies on.
   */
  function notifySaved() {
    var outer = currentEditor;
    var inner = outer && outer.vditor;
    if (outer && typeof outer.getValue === 'function'
      && inner && inner.options && typeof inner.options.input === 'function') {
      inner.options.input(outer.getValue());
    }
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

  // CSS markers are list structure, not document text. Track whole-item
  // selections without injecting marker strings into the selected content.
  function hasSelectedContent(fragment) {
    fragment.querySelectorAll('.' + SPAN_CLASS + ', wbr').forEach(function (node) { node.remove(); });
    return fragment.textContent.replace(/\u200b/g, '').trim() !== ''
      || !!fragment.querySelector('img, video, audio, iframe, hr, table, svg, canvas');
  }

  function coversContents(range, element) {
    if (!range.intersectsNode(element)
      || range.comparePoint(element, 0) === 1
      || range.comparePoint(element, element.childNodes.length) === -1) return false;
    var probe = document.createRange();
    probe.selectNodeContents(element);
    if (range.comparePoint(element, 0) === -1) {
      probe.setEnd(range.startContainer, range.startOffset);
      if (hasSelectedContent(probe.cloneContents())) return false;
    }
    probe.selectNodeContents(element);
    if (range.comparePoint(element, element.childNodes.length) === 1) {
      probe.setStart(range.endContainer, range.endOffset);
      if (hasSelectedContent(probe.cloneContents())) return false;
    }
    return true;
  }

  function prepareSelectionReplacement(event) {
    if (!inEditorMode()) return;
    var editor = editorEl();
    if (editor.getAttribute('contenteditable') === 'false'
      || (event && !editor.contains(event.target))) return false;
    var sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0).cloneRange();
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
    var list = Array.from(editor.querySelectorAll('ol[data-block], ul[data-block]')).find(function (candidate) {
      return candidate.contains(range.startContainer) && candidate.contains(range.endContainer)
        && coversContents(range, candidate);
    });
    var first = closestLi(range.startContainer);
    var last = closestLi(range.endContainer);
    if (!list && first && last && first.parentElement === last.parentElement
      && coversContents(range, first) && coversContents(range, last)) list = first.parentElement;
    if (!list) return false;
    if (!first || first.parentElement !== list) first = list.firstElementChild;
    if (!last || last.parentElement !== list) last = list.lastElementChild;
    var inner = currentEditor.vditor;
    inner.undo.addToUndoStack(inner);
    // Merely widening the native selection is insufficient: Chromium retains
    // the list shell and can pull the following paragraph into its first item.
    // Replace the selected structure with a paragraph for the existing input /
    // paste pipeline to fill, and record the original document for undo first.
    var paragraph = document.createElement('p');
    paragraph.setAttribute('data-block', '0');
    paragraph.innerHTML = '<wbr><br>';
    var tail = list.cloneNode(false);
    while (last.nextSibling) tail.appendChild(last.nextSibling);
    var item = first;
    while (item) {
      var next = item.nextSibling;
      item.remove();
      if (item === last) break;
      item = next;
    }
    list.insertAdjacentElement('afterend', paragraph);
    if (tail.children.length) {
      if (tail.tagName === 'OL') {
        var marker = tail.firstElementChild.getAttribute('data-marker');
        if (marker) {
          tail.setAttribute('data-marker', marker);
          tail.setAttribute('start', String(parseInt(marker, 10)));
        }
      }
      paragraph.insertAdjacentElement('afterend', tail);
    }
    if (!list.children.length) list.remove();
    range.setStart(paragraph, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  function reportSelectionDelete() {
    editorEl().dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'deleteContentBackward', data: null,
    }));
  }

  function onBeforeInputCapture(event) {
    if (event.isComposing) return;
    if (/^(delete|insert)/.test(event.inputType || '') && prepareSelectionReplacement(event)
      && event.inputType.indexOf('delete') === 0) {
      event.preventDefault();
      event.stopPropagation();
      reportSelectionDelete();
    }
  }

  function onPasteCapture(event) {
    var data = event.clipboardData;
    if (event.defaultPrevented || !data || (!data.getData('text/plain') && !data.getData('text/html'))) return;
    prepareSelectionReplacement(event);
  }

  function onSelectionChange() {
    if (!inEditorMode()) return;
    var editor = editorEl();

    var sel = document.getSelection();
    var activeLi = (sel && sel.rangeCount > 0) ? closestLi(sel.anchorNode) : null;
    var selectedRange = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    editor.querySelectorAll('li[data-marker]:not(.vditor-task)').forEach(function (li) {
      li.classList.toggle('vmd-marker-selected', !!selectedRange && coversContents(selectedRange, li));
    });

    // Fold every stale span (previous line, undo-restored snapshots, …) back
    // into the attributes — but never the active line's while the caret is
    // still inside its span: that would reset marker text the user is
    // mid-edit on. Folding (not just clearing) commits the edit the user
    // made before clicking away.
    editor.querySelectorAll('.' + SPAN_CLASS).forEach(function (span) {
      var li = span.closest('li');
      if (li && li === activeLi) return;
      if (li) foldLive(li);
      else span.remove();
    });

    if (activeLi) {
      var live = liveSpanOf(activeLi);
      // Caret left the span but stayed on the line (clicked into the item
      // content): fold the edit, then ensureLive re-creates the span
      // showing the (possibly updated) marker — the line is still focused.
      if (live && caretSpan() !== live) foldLive(activeLi);
      ensureLive(activeLi);
    }
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
    // Caret is inside the marker span: swallow the event so vditor's handler
    // never sees the span text as li content. The edit itself already landed
    // in the span text (browser default). Committing is DEFERRED — Enter /
    // Space / Tab commit explicitly, leaving the span folds silently
    // (foldLive). Committing on every keystroke broke every multi-char
    // marker edit: the span was removed after the first char, so the second
    // char either landed in the item content or failed parseMarker and
    // vanished (user-visible: cannot renumber, typing dead).
    event.stopPropagation();
    var li = span.closest('li');
    if (li && spanMarkerText(span) === '') {
      // marker emptied via a selection-delete (Delete key: input event, not
      // the Backspace keydown path) — same lift as char-by-char backspace
      liftOutOfList(li);
    }
  }

  function onKeydownCapture(event) {
    // IME composition 期间不拦截（含候选确认的 Enter），与 fork 自身
    // processKeydown 的 isComposing 防护同级
    if (event.isComposing) return;
    if (!inEditorMode()) return;
    var sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    if (!sel.isCollapsed) {
      if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter'
        || (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)) {
        if (prepareSelectionReplacement(event) && (event.key === 'Backspace' || event.key === 'Delete')) {
          event.preventDefault();
          event.stopPropagation();
          reportSelectionDelete();
          return;
        }
      }
      // Marker-only editing must never swallow a cross-item selection.
      var selected = sel.getRangeAt(0);
      var selectedSpan = caretSpan();
      if (!selectedSpan || !selectedSpan.contains(selected.startContainer)
        || !selectedSpan.contains(selected.endContainer)) return;
    }

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

    if (event.key === 'Escape' && span) {
      // abandon an in-progress marker edit: drop the edited text, restore
      // the CSS-rendered (previous) marker. Condition mirrors Enter/Space
      // (caret INSIDE the span): with the caret in the content there is no
      // pending edit to abandon — swallowing would block the host's own
      // Escape semantics for no benefit
      event.preventDefault();
      event.stopPropagation();
      clearLive(li);
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
      // Keep a caret anchor when one was planted inside the span: the ir
      // compositionend path spins the DOM through Lute as a direct function
      // call (not an event — the interception layers never see it), and
      // stripping the span together with its wbr leaves setRangeByWbr
      // nothing to find, losing the caret. Spans without a wbr are removed
      // as before (serialization paths carry no anchor).
      var anchor = span.querySelector('wbr');
      if (anchor) span.replaceWith(anchor);
      else span.remove();
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
      document.addEventListener('mousedown', onMouseDownCapture, true);
      document.addEventListener('beforeinput', onBeforeInputCapture, true);
      document.addEventListener('paste', onPasteCapture, true);
    }
    wrapLute();
  }

  window.ListMarkerLive = { install: install };
})();
