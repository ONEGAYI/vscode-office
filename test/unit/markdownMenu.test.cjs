const assert = require('node:assert/strict');
const { test } = require('node:test');
const manifest = require('../../package.json');

test('the pencil is available for every extension accepted by the comparison menu', () => {
    const pencil = manifest.contributes.menus['editor/title'].find(item => item.command === 'office.markdown.switch');
    // Evaluate the resourceExtname clause in the contributed menu contract.
    const equality = /^resourceExtname == '([^']+)'$/.exec(pencil.when);
    const expression = /^resourceExtname =~ \/(.+)\/([i]*)$/.exec(pencil.when);
    const visible = extension => equality ? extension === equality[1]
        : expression && new RegExp(expression[1], expression[2]).test(extension);
    for (const extension of ['.md', '.markdown', '.MD', '.MARKDOWN']) {
        assert.equal(visible(extension), true, extension + ' needs a pencil action');
    }
    assert.equal(visible('.txt'), false);
});

test('the markdown viewer stays opt-in so .md files open with the default editor', () => {
    const viewer = manifest.contributes.customEditors
        .find(editor => editor.viewType === 'cweijan.markdownViewer');
    // Fork behavior: without priority "option" the viewer would take over .md
    // files again, and the switch command above would become the opt-out.
    assert.equal(viewer.priority, 'option');
});
