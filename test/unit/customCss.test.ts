import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
    collectSnippetCssText,
    readmeMarkdownContent,
    resolveSnippetDirPath,
    stripBom,
} from '../../src/service/markdown/customCssSnippets.ts';

/** 提取 vditor 源码里 EXPORT_CSS_VARS 白名单（动变量必碰的活清单）。 */
const readExportVars = (): Set<string> => {
    const source = readFileSync(
        join('vditor', 'src', 'ts', 'util', 'exportThemeSettings.ts'), 'utf8');
    const arrayBody = source.split('const EXPORT_CSS_VARS = [')[1]?.split(']')[0] ?? '';
    return new Set([...arrayBody.matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1]));
};

/**
 * 收集 vditor 源码里真正被消费的变量：样式中的 `var(--x)` 引用，加 TS 里
 * 以字符串字面量读取的变量（readCssVar/getPropertyValue 键、导出白名单）。
 * 只有"被定义"不算数——本 fork 主题文件里留有一批从未被消费的死变量
 * （如 --ir-* 组），README 把它们当可用变量宣传就是误导。
 */
const readConsumedVars = (): Set<string> => {
    const consumed = new Set<string>();
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const filePath = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(filePath);
            } else if (/\.(less|css|ts)$/.test(entry.name)) {
                const source = readFileSync(filePath, 'utf8');
                for (const m of source.matchAll(/var\((--[a-z0-9-]+)/g)) {
                    consumed.add(m[1]);
                }
                for (const m of source.matchAll(/"(--[a-z0-9-]+)"/g)) {
                    consumed.add(m[1]);
                }
            }
        }
    };
    walk(join('vditor', 'src'));
    return consumed;
};

const readmeVars = (): Set<string> =>
    new Set([...readmeMarkdownContent().matchAll(/(--[a-z0-9-]+)/g)].map((m) => m[1]));

describe('stripBom', () => {
    it('strips a leading UTF-8 BOM', () => {
        assert.equal(stripBom('\uFEFFbody { color: red }'), 'body { color: red }');
    });

    it('keeps text without BOM unchanged', () => {
        assert.equal(stripBom('body { color: red }'), 'body { color: red }');
    });
});

describe('readmeMarkdownContent', () => {
    it('warns the file is extension-managed (detect-then-write will clobber edits)', () => {
        const content = readmeMarkdownContent();
        assert.ok(content.includes('请勿编辑'), '缺"请勿编辑"警示');
        assert.ok(content.includes('会被覆盖'), '缺"会被覆盖"说明');
    });

    it('carries the variable catalog inline (readers never need repo sources)', () => {
        const content = readmeMarkdownContent();
        // 常用变量就地可查：不指路仓库源码（vsix 用户没有源码可翻）
        assert.ok(!content.includes('vditor/src/'), 'README 不指路仓库源码路径');
    });

    it('variable catalog reconciles with the living sources (no drift)', () => {
        const exported = readExportVars();
        const consumed = readConsumedVars();
        const readme = readmeVars();
        assert.ok(exported.size >= 40, `EXPORT_CSS_VARS 提取异常（${exported.size} 项）`);
        assert.ok(consumed.size >= 150, `vditor 消费变量提取异常（${consumed.size} 项）`);

        // 防漏：导出白名单的变量 README 必须全列（动 EXPORT 必同步 README）
        const missingFromReadme = [...exported].filter((name) => !readme.has(name));
        assert.deepEqual(missingFromReadme, [],
            'EXPORT_CSS_VARS 有变量未列进 README——同步后再提交');

        // 防陈旧+防死变量：README 列的每个变量必须有真实消费背书
        // （样式 var() 引用 / TS 字面量读取 / 导出捕获），仅有定义不算
        const authority = new Set([...exported, ...consumed]);
        const staleInReadme = [...readme].filter((name) => !authority.has(name));
        assert.deepEqual(staleInReadme, [],
            'README 列出了源码从未消费的变量——死变量/已删除项，先剔除再提交');
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
