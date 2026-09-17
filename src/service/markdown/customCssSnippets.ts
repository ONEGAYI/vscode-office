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
 * Scaffold dropped into a freshly created snippet directory. Comments only:
 * it participates in the overlay like any other file, so it must never
 * carry a rule.
 */
export const readmeCssContent = (): string => `/*
 * 自定义 CSS 片段目录（custom CSS snippets）
 *
 * 把任意 .css 文件放进本目录即可生效：所有文件按文件名字母序拼接，
 * 作为一个叠加层注入 Markdown 编辑器（在内置样式之后，可覆盖一切）。
 *
 * 用法提示：
 * - 停用某个文件：改扩展名（如 theme.css.disabled）或移出本目录
 * - 控制优先级：加载顺序即文件名字母序，后加载的规则覆盖先加载的；
 *   可用数字/下划线前缀排序（如 10-base.css 先于 90-tweaks.css）
 * - 主题级调整优先覆盖 CSS 变量，也可以直接写选择器改任意元素
 *
 * 常用 CSS 变量速查（在 :root 或任意选择器上覆盖即可）：
 *
 * 表面与文字：--bg-color 页面背景 | --front-color 正文色
 *   --second-bg-color 次级背景 | --second-color 次级文字
 *   --border-color 边框 | --hr-bg 分隔线
 * 链接与引用：--link-color 链接 | --wikilink-color 双链
 *   --blockquote-color/-border/-bg 引用块
 * 表格：--table-border | --table-header-bg | --table-body-bg
 * 行内代码：--code-bg-color | --code-fg-color
 * 代码块(CodeMirror)：--cm-bg-color | --cm-fg-color
 *   --cm-active-line-bg 当前行 | --cm-line-number-fg 行号
 *   --cm-selection-bg 选区
 * IR 语法着色：--ir-heading-color 标记标题 | --ir-title-color 纯标题
 *   --ir-bi-color 加粗斜体 | --ir-link-color | --ir-bracket-color
 * 图表色板：--chart-red | --chart-blue | --chart-yellow
 *   --chart-orange | --chart-green | --chart-purple
 * 排版与版面：--editor-font-size | --editor-line-height
 *   --editor-font-family | --code-font-family | --bold-color | --italic-color
 *   --vditor-page-width 页宽 | --vditor-image-max-width 图片最大宽
 * 滚动条：--scrollbar-thumb | --scrollbar-thumb-hover
 *
 * 边界：这里的样式属于"编辑器环境"，不会内联进导出的 HTML/PDF
 * 产物（导出时外部覆盖的变量值会被捕获，但选择器规则不会）。
 *
 * 本文件为纯注释，可安全保留，也可删掉。
 */
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
