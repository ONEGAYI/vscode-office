const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInNewContext } = require('node:vm');

const code = buildSync({
    entryPoints: [resolve(__dirname, '../../src/service/markdown/markdown-pdf.js')],
    bundle: true, platform: 'node', format: 'cjs', external: ['vscode', 'puppeteer-core', 'vscode-html-to-docx'], write: false,
}).outputFiles[0].text;
const moduleRef = { exports: {} };
runInNewContext(code, {
    module: moduleRef, exports: moduleRef.exports, require: (name) => {
        if (name === 'vscode') return { Uri: { file: (path) => ({ fsPath: path }) } };
        return require(name);
    },
    process, console, Buffer, setTimeout, clearTimeout,
    __dirname: resolve(__dirname, '../../out'),
});

test('HTML export adds a script nonce and removes document-owned scripts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-export-security-'));
    const markdownFilePath = path.join(dir, 'sample.md');
    const htmlPath = path.join(dir, 'sample.html');
    try {
        fs.writeFileSync(markdownFilePath,
            '<script>window.bad=1</script>\n\n```mermaid\ngraph TD; A-->B\n```');
        await moduleRef.exports.convertMd({ markdownFilePath, config: { type: ['html'], withoutOutline: true } });
        const html = fs.readFileSync(htmlPath, 'utf8');
        const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
        assert.ok(nonce);
        assert.doesNotMatch(html, /window\.bad|<script(?! nonce=)/i);
        assert.ok(html.includes(`<script nonce="${nonce}" src=`));
        assert.ok(html.includes(`<script nonce="${nonce}">mermaid.initialize`));
    } finally {
        if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
        fs.unlinkSync(markdownFilePath);
        fs.rmdirSync(dir);
    }
});

test('Markdown export removes document scripts but keeps safe formatting and diagram markup', () => {
    const html = moduleRef.exports.convertMarkdownToHtml('/tmp/a.md', 'pdf',
        'hello <b>bold</b><img src="x" onerror="window.bad=1"><script>window.bad=2</script>\n\n```mermaid\ngraph TD; A-->B\n```',
        { withoutOutline: true });
    assert.match(html, /<b>bold<\/b>/);
    assert.match(html, /class="mermaid"/);
    assert.doesNotMatch(html, /onerror|<script|window\.bad/i);
});

test('Markdown task lists retain inert checkboxes in exported HTML', () => {
    const html = moduleRef.exports.convertMarkdownToHtml('/tmp/a.md', 'html',
        '- [x] done\n- [ ] later', { withoutOutline: true });
    assert.equal((html.match(/<input\b/g) || []).length, 2);
    assert.match(html, /type="checkbox"/);
    assert.match(html, /checked/);
    assert.equal((html.match(/<label\b/g) || []).length, 2);
});

test('Markdown export retains a quoted font family without allowing active HTML', () => {
    const html = moduleRef.exports.convertMarkdownToHtml('/tmp/a.md', 'pdf',
        '<span style="font-family: \'Times New Roman\'">formatted</span>',
        { withoutOutline: true });
    assert.match(html, /font-family:\s*'Times New Roman'/);
});
