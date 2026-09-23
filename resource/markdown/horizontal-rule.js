/** Show a thematic break as source text on its active line and as <hr> elsewhere. */
(function () {
  'use strict';

  var currentEditor = null;

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

  function revealRule(root, rule, atStart) {
    var paragraph = document.createElement('p');
    paragraph.setAttribute('data-block', '0');
    paragraph.textContent = '---';
    rule.replaceWith(paragraph);
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
    if (after && after.nodeType === Node.ELEMENT_NODE && after.matches('hr[data-block]')) {
      return { rule: after, atStart: true };
    }
    var before = root.childNodes[selection.anchorOffset - 1];
    if (before && before.nodeType === Node.ELEMENT_NODE && before.matches('hr[data-block]')) {
      return { rule: before, atStart: false };
    }
    return null;
  }

  function sync() {
    var root = editorElement();
    if (!root) return;
    var focusedRule = ruleAtCaret(root);
    if (focusedRule) revealRule(root, focusedRule.rule, focusedRule.atStart);
    var active = activeParagraph(root);
    var selection = document.getSelection();
    var selectedRange = document.activeElement === root && selection && selection.rangeCount
      && root.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
    root.querySelectorAll(':scope > p[data-block]').forEach(function (paragraph) {
      if (paragraph === active || (selectedRange && selectedRange.intersectsNode(paragraph))) return;
      if (!isRuleParagraph(paragraph)) return;
      var rule = document.createElement('hr');
      rule.setAttribute('data-block', '0');
      paragraph.replaceWith(rule);
    });
  }

  function editRule(event) {
    if (!(event.target instanceof Element)) return;
    var root = editorElement();
    var rule = event.target.closest('hr[data-block]');
    if (!root || !rule || rule.parentElement !== root) return;

    event.preventDefault();
    event.stopPropagation();
    revealRule(root, rule, false);
  }

  function install(editor) {
    currentEditor = editor;
    if (!window.__vmdHorizontalRuleInstalled) {
      window.__vmdHorizontalRuleInstalled = true;
      document.addEventListener('input', sync, false);
      document.addEventListener('selectionchange', sync, false);
      document.addEventListener('focusout', function () { setTimeout(sync, 0); }, false);
      document.addEventListener('mousedown', editRule, true);
    }
    sync();
  }

  window.HorizontalRuleLive = { install: install };
})();
