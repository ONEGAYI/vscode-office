/** Show a thematic break as source text on its active line and as <hr> elsewhere. */
(function () {
  'use strict';

  var currentEditor = null;
  var trackedRoot = null;
  var pendingParagraphs = new Set();
  var sourceText = null;
  var sourcePending = false;
  var editableRules = new WeakMap();

  function editorElement() {
    var vditor = currentEditor && currentEditor.vditor;
    if (!vditor || (vditor.currentMode !== 'ir' && vditor.currentMode !== 'wysiwyg')) return null;
    return vditor[vditor.currentMode] && vditor[vditor.currentMode].element;
  }

  function activeParagraph(root) {
    var selection = document.getSelection();
    if (!root || document.activeElement !== root || !selection || !selection.rangeCount
      || !root.contains(selection.anchorNode)) return null;
    var node = selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode : selection.anchorNode.parentElement;
    var paragraph = node && node.closest('p[data-block]');
    return paragraph && paragraph.parentElement === root ? paragraph : null;
  }

  function isRuleParagraph(paragraph, root) {
    if (paragraph.tagName !== 'P' || paragraph.parentElement !== (root || editorElement())) return false;
    // A soft break or inline markup must not be mistaken for a standalone rule.
    if (Array.from(paragraph.children).some(function (child) { return child.tagName !== 'WBR'; })) return false;
    return paragraph.textContent.replace(/\u200b/g, '') === '---';
  }

  function isCountableBlock(element) {
    if (/^(?:P|H[1-6]|UL|OL|BLOCKQUOTE|TABLE|PRE|HR)$/.test(element.tagName)) {
      if (element.tagName !== 'P') return true;
      return element.textContent.replace(/[\u200b\n\r\t ]/g, '') !== ''
        || Array.from(element.children).some(function (child) {
          return child.tagName !== 'BR' && child.tagName !== 'WBR';
        });
    }
    return element.tagName === 'DIV' && !!element.getAttribute('data-type');
  }

  function sourceRuleMarkers(lines) {
    var markers = [];
    var paragraph = false;
    var fence = null;
    var start = 0;
    if (lines[0]?.trim() === '---') {
      var close = lines.findIndex(function (line, index) { return index > 0 && line.trim() === '---'; });
      if (close > 0) start = close + 1; // YAML front matter, not two rules.
    }
    for (var i = start; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (fence) {
        if (new RegExp('^' + fence.char + '{' + fence.length + ',}$').test(trimmed)) fence = null;
        continue;
      }
      if (!trimmed) { paragraph = false; continue; }
      var opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (opening) {
        fence = { char: opening[1][0], length: opening[1].length };
        paragraph = false;
        continue;
      }
      var marker = !/^(?: {4}|\t)/.test(line)
        && /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed.replace(/[ \t]/g, ''));
      if (marker) {
        // A dashed underline immediately after paragraph text is a Setext heading.
        if (!(paragraph && /^-{3,}$/.test(trimmed))) markers.push(trimmed);
        paragraph = false;
        continue;
      }
      paragraph = !/^(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|[0-9]+[.)][ \t]|>|\||<|\$\$)/.test(trimmed)
        && !/^(?: {4}|\t)/.test(line);
    }
    return markers;
  }

  function cacheCurrentRules(root) {
    var rules = Array.from(root.querySelectorAll(':scope > hr[data-block]'));
    if (rules.every(function (rule) { return editableRules.has(rule); })) return;
    var lines = typeof sourceText === 'string' ? sourceText.split('\n') : [];
    var starts = lines.length && window.BlockLineNumbers?.computeBlockStarts
      ? window.BlockLineNumbers.computeBlockStarts(sourceText) : [];
    var blocks = starts.length ? Array.from(root.children).filter(isCountableBlock) : [];
    var blockIndex = new Map(blocks.map(function (block, index) { return [block, index]; }));
    // Lists can split into more DOM blocks than source block starts. Pair by
    // rule order only when every source marker has a top-level DOM counterpart.
    var markers = sourceRuleMarkers(lines);
    rules.forEach(function (rule, ruleIndex) {
      if (editableRules.has(rule)) return;
      var marker = null;
      var index = blockIndex.get(rule);
      if (index !== undefined && blocks.length === starts.length) {
        var sourceLine = lines[starts[index] - 1]?.trim();
        if (sourceLine && /^(?:-{3,}|\*{3,}|_{3,})$/.test(sourceLine.replace(/[ \t]/g, ''))) {
          marker = sourceLine;
        }
      }
      if (marker === null && markers.length === rules.length) marker = markers[ruleIndex].trim();
      // Unknown provenance is left alone rather than changing another spelling.
      editableRules.set(rule, marker === '---');
    });
  }

  function isEditableRule(root, rule) {
    if (!editableRules.has(rule)) cacheCurrentRules(root);
    return editableRules.get(rule) === true;
  }

  function logicalRules(root) {
    return Array.from(root.children).filter(function (element) {
      return element.matches('hr[data-block]') || isRuleParagraph(element, root);
    });
  }

  function revealRule(root, rule, atStart) {
    var paragraph = document.createElement('p');
    paragraph.setAttribute('data-block', '0');
    paragraph.textContent = '---';
    rule.replaceWith(paragraph);
    pendingParagraphs.add(paragraph);
    root.focus();
    var range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(atStart);
    var selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function ruleAtCaret(root) {
    var selection = document.getSelection();
    if (document.activeElement !== root || !selection || !selection.rangeCount
      || !selection.isCollapsed || selection.anchorNode !== root) return null;
    var after = root.childNodes[selection.anchorOffset];
    if (after && after.nodeType === Node.ELEMENT_NODE && after.matches('hr[data-block]')
      && isEditableRule(root, after)) {
      return { rule: after, atStart: true };
    }
    var before = root.childNodes[selection.anchorOffset - 1];
    if (before && before.nodeType === Node.ELEMENT_NODE && before.matches('hr[data-block]')
      && isEditableRule(root, before)) {
      return { rule: before, atStart: false };
    }
    return null;
  }

  function sync() {
    var root = editorElement();
    if (!root) return;
    if (root !== trackedRoot) {
      if (trackedRoot) {
        var oldRules = logicalRules(trackedRoot);
        var newRules = logicalRules(root);
        if (oldRules.length === newRules.length) {
          oldRules.forEach(function (oldRule, index) {
            if (newRules[index].tagName !== 'HR') return;
            if (oldRule.tagName === 'P') editableRules.set(newRules[index], true);
            else if (editableRules.has(oldRule)) editableRules.set(newRules[index], editableRules.get(oldRule));
          });
        }
      }
      trackedRoot = root;
      pendingParagraphs.clear();
      root.querySelectorAll(':scope > p[data-block]').forEach(function (paragraph) {
        if (isRuleParagraph(paragraph)) pendingParagraphs.add(paragraph);
      });
    }
    var focusedRule = ruleAtCaret(root);
    if (focusedRule) revealRule(root, focusedRule.rule, focusedRule.atStart);
    var active = activeParagraph(root);
    if (active && isRuleParagraph(active)) pendingParagraphs.add(active);
    var selection = document.getSelection();
    var selectedRange = document.activeElement === root && selection && selection.rangeCount
      && root.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
    pendingParagraphs.forEach(function (paragraph) {
      if (!isRuleParagraph(paragraph)) {
        pendingParagraphs.delete(paragraph);
        return;
      }
      if (paragraph === active || (selectedRange && selectedRange.intersectsNode(paragraph))) return;
      var rule = document.createElement('hr');
      rule.setAttribute('data-block', '0');
      paragraph.replaceWith(rule);
      editableRules.set(rule, true);
      pendingParagraphs.delete(paragraph);
    });
  }

  function editRule(event) {
    if (!(event.target instanceof Element)) return;
    var root = editorElement();
    var rule = event.target.closest('hr[data-block]');
    if (!root || !rule || rule.parentElement !== root || !isEditableRule(root, rule)) return;

    event.preventDefault();
    event.stopPropagation();
    revealRule(root, rule, false);
  }

  function setSource(text) {
    if (typeof text !== 'string') {
      // The host round trip can normalize *** to ---. Keep original DOM
      // provenance before the serialized content is acknowledged.
      var root = editorElement();
      if (root) cacheCurrentRules(root);
      sourcePending = true;
      return;
    }
    if (!sourcePending) editableRules = new WeakMap();
    sourceText = text;
    sourcePending = false;
  }

  function install(editor, options) {
    currentEditor = editor;
    if (options && Object.prototype.hasOwnProperty.call(options, 'sourceText')) {
      setSource(options.sourceText);
    }
    if (!window.__vmdHorizontalRuleInstalled) {
      window.__vmdHorizontalRuleInstalled = true;
      document.addEventListener('input', sync, false);
      document.addEventListener('selectionchange', sync, false);
      document.addEventListener('focusout', function () { setTimeout(sync, 0); }, false);
      document.addEventListener('mousedown', editRule, true);
    }
    sync();
  }

  window.HorizontalRuleLive = { install: install, setSource: setSource };
})();
