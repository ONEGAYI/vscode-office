/** Show a thematic break as source text on its active line and as <hr> elsewhere. */
(function () {
  'use strict';

  var currentEditor = null;
  var trackedRoot = null;
  var pendingParagraphs = new Set();
  var sourceText = null;
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

  function isRuleParagraph(paragraph) {
    if (paragraph.tagName !== 'P' || paragraph.parentElement !== editorElement()) return false;
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

  function isEditableRule(root, rule) {
    if (editableRules.has(rule)) return editableRules.get(rule);
    var editable = true;
    if (typeof sourceText === 'string' && window.BlockLineNumbers?.computeBlockStarts) {
      var starts = window.BlockLineNumbers.computeBlockStarts(sourceText);
      var blocks = Array.from(root.children).filter(isCountableBlock);
      var index = blocks.indexOf(rule);
      if (index >= 0 && blocks.length === starts.length) {
        var sourceLine = sourceText.split('\n')[starts[index] - 1].trim();
        var compact = sourceLine.replace(/[ \t]/g, '');
        if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(compact) && sourceLine !== '---') {
          editable = false;
        }
      }
    }
    editableRules.set(rule, editable);
    return editable;
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
    sourceText = typeof text === 'string' ? text : null;
    editableRules = new WeakMap();
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
