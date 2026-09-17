import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    collectSnippetCssText,
    readmeCssContent,
    resolveSnippetDirPath,
    stripBom,
} from '../../src/service/markdown/customCssSnippets.ts';

describe('stripBom', () => {
    it('strips a leading UTF-8 BOM', () => {
        assert.equal(stripBom('\uFEFFbody { color: red }'), 'body { color: red }');
    });

    it('keeps text without BOM unchanged', () => {
        assert.equal(stripBom('body { color: red }'), 'body { color: red }');
    });
});

describe('readmeCssContent', () => {
    it('is pure comments (no active rules ever load from the scaffold)', () => {
        const content = readmeCssContent();
        const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
        assert.equal(withoutComments.trim(), '');
    });

    it('carries the variable catalog inline (readers never need repo sources)', () => {
        const content = readmeCssContent();
        // 常用变量就地可查：不指路仓库源码（vsix 用户没有源码可翻）
        assert.ok(!content.includes('vditor/src/'), 'README 不指路仓库源码路径');
        for (const variable of ['--bg-color', '--front-color', '--link-color', '--code-bg-color',
            '--cm-bg-color', '--ir-heading-color', '--chart-red', '--editor-font-size',
            '--vditor-page-width', '--scrollbar-thumb']) {
            assert.ok(content.includes(variable), `README 缺变量 ${variable}`);
        }
    });
});

describe('resolveSnippetDirPath', () => {
    it('joins the snippet directory under the given home directory', () => {
        assert.equal(
            resolveSnippetDirPath('C:\\Users\\suian'),
            'C:\\Users\\suian\\.vscode-office-css',
        );
    });

    it('returns undefined when home is unavailable (web mode disables the feature)', () => {
        assert.equal(resolveSnippetDirPath(undefined), undefined);
        assert.equal(resolveSnippetDirPath(''), undefined);
    });
});

describe('collectSnippetCssText', () => {
    it('returns an empty string for an empty directory', async () => {
        assert.equal(await collectSnippetCssText([]), '');
    });

    it('concatenates snippets in filename order with a name banner between files', async () => {
        const css = await collectSnippetCssText([
            { name: 'theme.css', read: async () => 'b { color: blue }' },
            { name: 'a.css', read: async () => 'a { color: red }' },
        ]);
        const aIndex = css.indexOf('a { color: red }');
        const bIndex = css.indexOf('b { color: blue }');
        assert.ok(aIndex >= 0 && bIndex >= 0, 'both snippets present');
        assert.ok(aIndex < bIndex, 'a.css loads before theme.css');
        assert.ok(css.includes('a.css'), 'banner names the source file');
    });

    it('strips the BOM of each file before joining', async () => {
        const css = await collectSnippetCssText([
            { name: 'bom.css', read: async () => '\uFEFFp { margin: 0 }' },
        ]);
        assert.ok(css.includes('p { margin: 0 }'));
        assert.ok(!css.includes('\uFEFF'));
    });

    it('skips a file that fails to read and keeps the rest', async () => {
        const css = await collectSnippetCssText([
            { name: 'broken.css', read: async () => { throw new Error('EBUSY'); } },
            { name: 'fine.css', read: async () => 'h1 { font-weight: 400 }' },
        ]);
        assert.ok(!css.includes('broken.css'), 'a skipped file leaves no banner behind');
        assert.ok(css.includes('h1 { font-weight: 400 }'));
    });

    it('reports skipped files through onError', async () => {
        const failures: Array<{ name: string; error: unknown }> = [];
        await collectSnippetCssText(
            [{ name: 'locked.css', read: async () => { throw new Error('EPERM'); } }],
            (name, error) => failures.push({ name, error }),
        );
        assert.equal(failures.length, 1);
        assert.equal(failures[0].name, 'locked.css');
    });
});
