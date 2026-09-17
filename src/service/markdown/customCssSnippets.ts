/**
 * Pure snippet logic for the custom-CSS overlay.
 *
 * Everything in this module is free of vscode imports so the unit tests
 * can load it directly under `node --test`; the vscode-facing shell lives
 * in customCssService.ts.
 */

import { join } from 'path';

/** Directory under the user's home that holds one `.css` file per snippet. */
export const SNIPPET_DIR_NAME = '.vscode-office-css';

/** id of the `<style>` element the webview maintains for the overlay. */
export const CUSTOM_CSS_STYLE_ID = 'office-custom-css';

export interface SnippetSource {
    name: string;
    read: () => Promise<string>;
}

export const stripBom = (text: string): string =>
    text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/** Web mode has no home directory: the feature silently disables itself. */
export const resolveSnippetDirPath = (homeDir: string | undefined): string | undefined => {
    if (!homeDir) {
        return undefined;
    }
    return join(homeDir, SNIPPET_DIR_NAME);
};

/**
 * Extension-owned documentation for the snippet directory, written to
 * `README.md`. Regenerated whenever the on-disk copy differs from the
 * template (detect-then-write), so the user's copy always matches the
 * installed extension — it cannot go stale across upgrades. The file is
 * Markdown on purpose: the `*.css` scanner and the watcher ignore it, so
 * rewriting it never joins the overlay nor triggers a reload. Unit tests
 * reconcile its variable catalog against the living sources
 * (EXPORT_CSS_VARS + Auto.css) so the template cannot drift from code.
 */
export const readmeMarkdownContent = (): string => `# 自定义 CSS 片段（custom CSS snippets）

> **本文件由扩展自动管理**：每次启动会被更新为当前版本内容，请勿编辑
> （手工修改会被覆盖）。自己的样式请新建 \`.css\` 文件放在本目录。

把任意 \`.css\` 文件放进本目录即可生效：所有文件按文件名字母序拼接，
作为一个叠加层注入 Markdown 编辑器（在内置样式之后，可覆盖一切）。

## 用法

- 停用某个文件：改扩展名（如 \`theme.css.disabled\`）或移出本目录
- 控制优先级：加载顺序即文件名字母序，后加载的规则覆盖先加载的；
  可用数字/下划线前缀排序（如 \`10-base.css\` 先于 \`90-tweaks.css\`）
- 主题级调整优先覆盖 CSS 变量，也可以直接写选择器改任意元素

## CSS 变量速查

在 \`:root\` 或任意选择器上覆盖即可生效。

**表面与文字**：\`--bg-color\` 页面背景 | \`--front-color\` 正文色 |
\`--second-color\` 次级文字 | \`--second-bg-color\` 次级背景

**边框与分隔**：\`--border-color\` 边框 | \`--hr-bg\` 分隔线

**链接**：\`--link-color\` | \`--wikilink-color\` | \`--list-hover-color\` 悬停

**引用块**：\`--blockquote-color\` | \`--blockquote-border\` | \`--blockquote-bg\`

**表格**：\`--table-border\` | \`--table-row-border\` | \`--table-header-bg\` | \`--table-body-bg\`

**行内代码**：\`--code-bg-color\` | \`--code-fg-color\`

**排版**：\`--editor-font-size\` | \`--editor-line-height\` | \`--editor-font-family\` |
\`--code-font-family\` | \`--bold-color\` | \`--italic-color\`

**版面**：\`--vditor-page-width\` | \`--vditor-image-max-width\` | \`--vditor-image-max-height\`

**代码块底色**：\`--cm-bg-color\` | \`--cm-fg-color\`

**代码高亮**：\`--cm-syntax-comment\` | \`--cm-syntax-keyword\` | \`--cm-syntax-string\` |
\`--cm-syntax-number\` | \`--cm-syntax-atom\` | \`--cm-syntax-property\` |
\`--cm-syntax-attribute\` | \`--cm-syntax-variable\` | \`--cm-syntax-def\` |
\`--cm-syntax-bracket\` | \`--cm-syntax-tag\` | \`--cm-syntax-link\` | \`--cm-syntax-error\`

**IR 语法着色**：\`--ir-heading-color\` 标记标题 | \`--ir-title-color\` 纯标题 |
\`--ir-bi-color\` 加粗斜体 | \`--ir-link-color\` | \`--ir-bracket-color\` | \`--ir-paren-color\`

**图表色板**：\`--chart-red\` | \`--chart-blue\` | \`--chart-yellow\` | \`--chart-orange\` |
\`--chart-green\` | \`--chart-purple\` | \`--chart-foreground\`

**滚动条**：\`--scrollbar-thumb\` | \`--scrollbar-thumb-hover\`

## 元素级定制（选择器示例）

变量覆盖的是全局值；标题这类**没有专用变量**的元素（颜色继承正文、
字体字号跟随内容区）用选择器改，内容区根选择器为 \`.vditor-reset\`
（wysiwyg / ir / 预览三模式共用）：

\`\`\`css
/* 标题统一换颜色 / 字体 */
.vditor-reset h1, .vditor-reset h2, .vditor-reset h3,
.vditor-reset h4, .vditor-reset h5, .vditor-reset h6 {
  color: var(--chart-blue);
  font-family: "Microsoft YaHei", sans-serif;
}
/* 只调某一级字号：默认 h1 1.75em / h2 1.55em / h3 1.38em / h4 1.25em */
.vditor-reset h2 { font-size: 1.3em; }
\`\`\`

注意：\`--ir-heading-color\` 只染 IR 模式的 \`#\` 标记，不作用于标题文本；
标题 Hx 左侧的 H1/H2 徽标是 \`::before\` 生成，一般不要覆盖。

## 边界

这里的样式属于"编辑器环境"，不会内联进导出的 HTML/PDF 产物
（导出时外部覆盖的变量值会被捕获，但选择器规则不会）。
`;

/**
 * Concatenate snippets in filename order. A file that fails to read is
 * skipped entirely (no banner) and reported through `onError`; the rest
 * of the directory still loads.
 */
export const collectSnippetCssText = async (
    files: SnippetSource[],
    onError?: (name: string, error: unknown) => void,
): Promise<string> => {
    const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const parts: string[] = [];
    for (const file of ordered) {
        let text: string;
        try {
            text = stripBom(await file.read());
        } catch (error) {
            onError?.(file.name, error);
            continue;
        }
        parts.push(`/* ==== ${file.name} ==== */\n${text}`);
    }
    return parts.join('\n\n');
};
