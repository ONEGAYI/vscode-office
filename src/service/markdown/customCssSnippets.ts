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
 * - 主题级调整优先覆盖 CSS 变量（如 --bg-color、--front-color、
 *   --ir-heading-color），变量清单见 vditor/src/css/editor-theme/
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
