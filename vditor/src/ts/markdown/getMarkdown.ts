import {buildEditorHtmlForMarkdown} from "../codeBlock/codeMirrorManager";
import {formatMs, logPerf} from "../util/log";

// Lute 会跳过没有内容节点的 <li>，而 Markdown 的 `1. ` 重载后恰好生成
// 这种 DOM。只在送入序列化器的 HTML 副本中补 <br>，保留空列表项语义。
const preserveEmptyListItems = (html: string): string => html.replace(
    /(<li\b[^>]*>)((?:\s|\u200b|<wbr\s*\/?>)*)(<\/li>)/gi,
    "$1$2<br>$3",
);

export const getMarkdown = (vditor: IVditor) => {
    const debug = vditor.options.debugger;
    const totalStart = debug ? performance.now() : 0;

    let stepStart = debug ? performance.now() : 0;
    const html = preserveEmptyListItems(buildEditorHtmlForMarkdown(vditor));
    const buildHtmlMs = debug ? performance.now() - stepStart : 0;

    stepStart = debug ? performance.now() : 0;
    let markdown = "";
    if (vditor.currentMode === "wysiwyg") {
        markdown = vditor.lute.VditorDOM2Md(html);
    } else if (vditor.currentMode === "ir") {
        markdown = vditor.lute.VditorIRDOM2Md(html);
    }
    const toMarkdownMs = debug ? performance.now() - stepStart : 0;

    logPerf(debug, "[vditor markdown] getMarkdown", {
        buildHtmlMs: formatMs(buildHtmlMs),
        toMarkdownMs: formatMs(toMarkdownMs),
        totalMs: formatMs(debug ? performance.now() - totalStart : 0),
    });

    return markdown;
};
