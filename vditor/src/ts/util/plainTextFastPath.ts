/**
 * 非符号 insertText 快路径：跳过 wbr / SpinVditorDOM / outerHTML 替换。
 * 仅对首次加载足够长的文档启用，小文件保持原有全量 spin 行为。
 */

/** 达到技术长文体量（约 1.2 万字）后启用快路径 */
export const PLAIN_TEXT_FAST_PATH_MIN_LENGTH = 12_000;

/** 会触发 Markdown 结构或 spin 处理的字符（含空白） */
const MARKDOWN_TRIGGER_RE = /[`*_~#\-+>\[\]()|!$\\=\s]/;

export const containsMarkdownTriggerChar = (text: string): boolean => {
    return MARKDOWN_TRIGGER_RE.test(text);
};

export const isPlainTextFastPathEnabled = (vditor: IVditor): boolean => {
    return (vditor.documentInitialLength ?? 0) >= PLAIN_TEXT_FAST_PATH_MIN_LENGTH;
};

export const canUsePlainTextFastPath = (vditor: IVditor, event: InputEvent): boolean => {
    if (!isPlainTextFastPathEnabled(vditor)) {
        return false;
    }
    if (event.isComposing) {
        return false;
    }
    if (event.inputType !== "insertText") {
        return false;
    }
    if (!event.data) {
        return false;
    }
    if (!containsMarkdownTriggerChar(event.data)) {
        return true;
    }
    // A hyphen or plus between letters cannot start a list or thematic break.
    if (event.data !== "-" && event.data !== "+") {
        return false;
    }
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0) {
        return false;
    }
    const range = selection.getRangeAt(0);
    if (!range.collapsed || range.startContainer.nodeType !== 3) {
        return false;
    }
    const text = range.startContainer.textContent || "";
    const offset = range.startOffset;
    const isWordCharacter = (char: string) => /[\p{L}\p{N}]/u.test(char);
    return text.charAt(offset - 1) === event.data
        && isWordCharacter(text.charAt(offset - 2))
        && isWordCharacter(text.charAt(offset));
};
