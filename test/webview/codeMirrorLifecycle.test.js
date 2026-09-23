'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { TextDecoder, TextEncoder } = require('node:util');
const { webcrypto } = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'vditor', 'dist');
const fileUrl = p => 'file://' + p.replace(/\\/g, '/');
const markdown = Array.from({ length: 20 }, (_, i) => `\`\`\`js\nconst n = ${i};\n\`\`\``).join('\n\n');

async function boot(mode, content = markdown) {
    const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
        runScripts: 'dangerously', resources: 'usable',
        url: fileUrl(path.join(ROOT, '__code-mirror-lifecycle-test__.html')),
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const { document } = window;
    const observed = new Set();
    window.IntersectionObserver = class {
        observe(node) { observed.add(node); }
        unobserve(node) { observed.delete(node); }
        disconnect() { observed.clear(); }
    };
    window.TextDecoder = TextDecoder;
    window.TextEncoder = TextEncoder;
    window.crypto = webcrypto;
    window.fetch = () => Promise.reject(new Error('fetch stub'));
    document.execCommand = () => true;
    if (!('innerText' in window.HTMLElement.prototype)) {
        Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
            get() { return this.textContent; },
            set(value) { this.textContent = value; },
        });
    }
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.Range.prototype.getClientRects = () => [];
    window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    window.eval(fs.readFileSync(path.join(DIST, 'js', 'lute', 'lute.min.js'), 'utf8'));
    const script = document.createElement('script');
    script.id = 'vditorLuteScript';
    document.head.appendChild(script);
    window.eval(fs.readFileSync(path.join(DIST, 'js', 'i18n', 'en_US.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(DIST, 'index.min.js'), 'utf8'));
    let ready = false;
    const editor = new window.Vditor('app', {
        value: content, mode, lang: 'en_US', i18n: window.VditorI18n,
        cdn: fileUrl(path.join(ROOT, 'vditor')), cache: { enable: false },
        after() { ready = true; },
    });
    for (let i = 0; i < 60 && !ready; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    return { dom, editor, observed };
}

for (const mode of ['wysiwyg', 'ir']) {
    test(`${mode} edits plain text in a large list without replacing the whole list`, async () => {
        const content = Array.from({ length: 600 }, (_, i) => `- item ${i}: text text text text`).join('\n');
        const { dom, editor } = await boot(mode, content);
        try {
            const { window } = dom;
            const list = window.document.querySelector(`.vditor-${mode} .vditor-reset > ul`);
            assert.ok(list);
            const walker = window.document.createTreeWalker(list.querySelector('li'), window.NodeFilter.SHOW_TEXT);
            let textNode;
            while ((textNode = walker.nextNode()) && !textNode.nodeValue.includes('item 0')) {}
            assert.ok(textNode);
            textNode.nodeValue += 'x';
            const range = window.document.createRange();
            range.setStart(textNode, textNode.nodeValue.length);
            range.collapse(true);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            textNode.parentElement.dispatchEvent(new window.InputEvent('input', {
                bubbles: true, inputType: 'insertText', data: 'x',
            }));
            assert.equal(list.isConnected, true);
            assert.match(editor.getValue(), /item 0: text text text textx/);
            editor.destroy();
        } finally {
            dom.window.close();
        }
    });
}

for (const [from, to] of [['wysiwyg', 'ir'], ['ir', 'wysiwyg']]) {
    test(`destroy releases code blocks after switching ${from} to ${to}`, async () => {
        const { dom, editor, observed } = await boot(from);
        try {
            editor.setValue(markdown, true);
            assert.ok(observed.size > 0);
            const oldObserved = [...observed];
            editor.switchEditMode(to);
            assert.equal(oldObserved.some(node => observed.has(node)), false);
            editor.destroy();
            assert.equal(observed.size, 0);
            await new Promise(resolve => setTimeout(resolve, 100));
        } finally {
            dom.window.close();
        }
    });
}

for (const mode of ['wysiwyg', 'ir']) {
    test(`${mode} releases observed code blocks after full replacements and destroy`, async () => {
        const { dom, editor, observed } = await boot(mode);
        try {
            for (let i = 0; i < 3; i += 1) editor.setValue(markdown, true);
            assert.equal([...observed].every(node => node.isConnected), true);
            editor.destroy();
            assert.equal(observed.size, 0);
        } finally {
            dom.window.close();
        }
    });
}
