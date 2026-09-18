import {Constants} from "../constants";
import {removeCurrentToolbar} from "../toolbar/setToolbar";
import {listToggle} from "../util/fixBrowserBehavior";
import {hasClosestBlock, hasClosestByMatchTag} from "../util/hasClosest";
import {processCodeRender} from "../util/processCode";
import {renderCodeBlocks} from "../codeBlock/codeMirrorManager";
import {getEditorRange, setRangeByWbr, setSelectionFocus, captureSelectionOffsets, restoreSelectionOffsets} from "../util/selection";
import {afterRenderEvent} from "./afterRenderEvent";
import {genAPopover, highlightToolbarWYSIWYG} from "./highlightToolbarWYSIWYG";

/** 只解开光标所在的这一层内联样式，保留嵌套内容及原光标位置。 */
const unwrapInlineAtCaret = (range: Range, vditor: IVditor, element: HTMLElement) => {
    // 首次快捷键的 undo 光标快照可能留下无文本的非 collapsed Range。
    range.collapse(true);
    range.insertNode(document.createElement("wbr"));
    while (element.firstChild) {
        element.parentNode.insertBefore(element.firstChild, element);
    }
    element.remove();
    setRangeByWbr(vditor.wysiwyg.element, range);
};

/** 原生命令可能留下元素边界选区；按操作前的文本位置重建，避免随后塌缩。 */
const execInlineKeepSelection = (vditor: IVditor, commandName: string) => {
    const savedSelection = captureSelectionOffsets(vditor);
    restoreSelectionOffsets(vditor, savedSelection);
    document.execCommand(commandName, false, "");
    restoreSelectionOffsets(vditor, savedSelection);
};

export const toolbarEvent = (vditor: IVditor, actionBtn: Element, event: Event) => {
    if (vditor.wysiwyg.composingLock // Mac Chrome 中韩文结束会出发此事件，导致重复末尾字符 https://github.com/Vanessa219/vditor/issues/188
        && event instanceof CustomEvent // 点击按钮应忽略输入法 https://github.com/Vanessa219/vditor/issues/473
    ) {
        return;
    }

    let useHighlight = true;
    let useRender = true;
    if (vditor.wysiwyg.element.querySelector("wbr")) {
        vditor.wysiwyg.element.querySelector("wbr").remove();
    }
    const range = getEditorRange(vditor);

    let commandName = actionBtn.getAttribute("data-type");

    // 移除
    if (actionBtn.classList.contains("vditor-menu--current")) {
        if (commandName === "strike") {
            commandName = "strikeThrough";
        }

        if (commandName === "quote") {
            let quoteElement = hasClosestByMatchTag(range.startContainer, "BLOCKQUOTE");
            if (!quoteElement) {
                quoteElement = range.startContainer.childNodes[range.startOffset] as HTMLElement;
            }
            if (quoteElement) {
                useHighlight = false;
                actionBtn.classList.remove("vditor-menu--current");
                const savedSelection = captureSelectionOffsets(vditor);
                range.insertNode(document.createElement("wbr"));
                quoteElement.outerHTML = quoteElement.innerHTML.trim() === "" ?
                    `<p data-block="0">${quoteElement.innerHTML}</p>` : quoteElement.innerHTML;
                if (!restoreSelectionOffsets(vditor, savedSelection)) {
                    setRangeByWbr(vditor.wysiwyg.element, range);
                }
            }
        } else if (commandName === "inline-code") {
            let inlineCodeElement = hasClosestByMatchTag(range.startContainer, "CODE");
            if (!inlineCodeElement) {
                inlineCodeElement = range.startContainer.childNodes[range.startOffset] as HTMLElement;
            }
            if (inlineCodeElement) {
                if (range.toString() === "") {
                    unwrapInlineAtCaret(range, vditor, inlineCodeElement);
                } else {
                    const savedSelection = captureSelectionOffsets(vditor);
                    inlineCodeElement.outerHTML = inlineCodeElement.innerHTML.replace(Constants.ZWSP, "") + "<wbr>";
                    if (!restoreSelectionOffsets(vditor, savedSelection)) {
                        setRangeByWbr(vditor.wysiwyg.element, range);
                    }
                }
            }
        } else if (commandName === "link") {
            if (range.toString() !== "") {
                execInlineKeepSelection(vditor, "unlink");
            } else {
                const linkElement = hasClosestByMatchTag(range.startContainer, "A");
                if (linkElement) {
                    unwrapInlineAtCaret(range, vditor, linkElement);
                }
            }
        } else if (commandName === "check" || commandName === "list" || commandName === "ordered-list") {
            listToggle(vditor, range, commandName);
            setRangeByWbr(vditor.wysiwyg.element, range);
            useHighlight = false;
            actionBtn.classList.remove("vditor-menu--current");
        } else {
            // bold, italic, strike
            useHighlight = false;
            actionBtn.classList.remove("vditor-menu--current");
            if (range.toString() === "") {
                const selector = commandName === "bold" ? "strong,b" :
                    commandName === "italic" ? "em,i" : "s,strike";
                const container = range.startContainer.nodeType === 3 ?
                    range.startContainer.parentElement : range.startContainer as HTMLElement;
                const inlineElement = container.closest<HTMLElement>(selector);
                if (inlineElement && vditor.wysiwyg.element.contains(inlineElement)) {
                    unwrapInlineAtCaret(range, vditor, inlineElement);
                }
            } else {
                execInlineKeepSelection(vditor, commandName);
            }
        }
    } else {
        // 添加
        if (vditor.wysiwyg.element.childNodes.length === 0) {
            vditor.wysiwyg.element.innerHTML = '<p data-block="0"><wbr></p>';
            setRangeByWbr(vditor.wysiwyg.element, range);
        }

        let blockElement = hasClosestBlock(range.startContainer);
        if (commandName === "quote") {
            if (!blockElement) {
                blockElement = range.startContainer.childNodes[range.startOffset] as HTMLElement;
            }

            if (blockElement) {
                useHighlight = false;
                actionBtn.classList.add("vditor-menu--current");
                const savedSelection = captureSelectionOffsets(vditor);
                range.insertNode(document.createElement("wbr"));

                const liElement = hasClosestByMatchTag(range.startContainer, "LI");
                // li 中软换行
                if (liElement && blockElement.contains(liElement)) {
                    liElement.innerHTML = `<blockquote data-block="0">${liElement.innerHTML}</blockquote>`;
                } else {
                    blockElement.outerHTML = `<blockquote data-block="0">${blockElement.outerHTML}</blockquote>`;
                }
                if (!restoreSelectionOffsets(vditor, savedSelection)) {
                    setRangeByWbr(vditor.wysiwyg.element, range);
                }
            }
        } else if (commandName === "check" || commandName === "list" || commandName === "ordered-list") {
            listToggle(vditor, range, commandName, false);
            setRangeByWbr(vditor.wysiwyg.element, range);
            useHighlight = false;
            removeCurrentToolbar(vditor.toolbar.elements, ["check", "list", "ordered-list"]);
            actionBtn.classList.add("vditor-menu--current");
        } else if (commandName === "inline-code") {
            if (range.toString() === "") {
                const node = document.createElement("code");
                node.textContent = Constants.ZWSP;
                range.insertNode(node);
                range.setStart(node.firstChild, 1);
                range.collapse(true);
                setSelectionFocus(range);
            } else {
                const savedSelection = captureSelectionOffsets(vditor);
                const node = document.createElement("code");
                node.textContent = range.toString();
                range.deleteContents();
                range.insertNode(node);
                if (!restoreSelectionOffsets(vditor, savedSelection)) {
                    range.selectNodeContents(node);
                    setSelectionFocus(range);
                }
            }
            actionBtn.classList.add("vditor-menu--current");
        } else if (commandName === "code") {
            const node = document.createElement("div");
            node.className = "vditor-wysiwyg__block";
            node.setAttribute("data-type", "code-block");
            node.setAttribute("data-block", "0");
            node.setAttribute("data-marker", "```");
            if (range.toString() === "") {
                node.innerHTML = "<pre><code><wbr>\n</code></pre>";
            } else {
                node.innerHTML = `<pre><code>${range.toString()}<wbr></code></pre>`;
                range.deleteContents();
            }
            range.insertNode(node);
            if (blockElement) {
                blockElement.outerHTML = vditor.lute.SpinVditorDOM(blockElement.outerHTML);
            }
            setRangeByWbr(vditor.wysiwyg.element, range);
            vditor.wysiwyg.element.querySelectorAll(".vditor-wysiwyg__preview[data-render='2']").forEach(
                (item: HTMLElement) => {
                    processCodeRender(item, vditor);
                });
            renderCodeBlocks(vditor);
            actionBtn.classList.add("vditor-menu--disabled");
        } else if (commandName === "link") {
            if (range.toString() === "") {
                const aElement = document.createElement("a");
                aElement.innerText = Constants.ZWSP;
                range.insertNode(aElement);
                range.setStart(aElement.firstChild, 1);
                range.collapse(true);
                genAPopover(vditor, aElement);
                const textInputElement = vditor.wysiwyg.popover.querySelector("input");
                textInputElement.value = "";
                textInputElement.focus();
                useRender = false;
            } else {
                const node = document.createElement("a");
                node.setAttribute("href", "");
                node.innerHTML = range.toString();
                range.surroundContents(node);
                range.insertNode(node);
                setSelectionFocus(range);
                genAPopover(vditor, node);
                const textInputElements = vditor.wysiwyg.popover.querySelectorAll("input");
                textInputElements[0].value = node.innerText;
                textInputElements[1].focus();
            }
            useHighlight = false;
            actionBtn.classList.add("vditor-menu--current");
        } else if (commandName === "table") {
            let tableHTML = `<table data-block="0"><thead><tr><th>col1<wbr></th><th>col2</th><th>col3</th></tr></thead><tbody><tr><td> </td><td> </td><td> </td></tr><tr><td> </td><td> </td><td> </td></tr></tbody></table>`;
            if (range.toString().trim() === "") {
                if (blockElement && blockElement.innerHTML.trim().replace(Constants.ZWSP, "") === "") {
                    blockElement.outerHTML = tableHTML;
                } else {
                    document.execCommand("insertHTML", false, tableHTML);
                }
                range.selectNode(vditor.wysiwyg.element.querySelector("wbr").previousSibling);
                vditor.wysiwyg.element.querySelector("wbr").remove();
                setSelectionFocus(range);
            } else {
                tableHTML = `<table data-block="0"><thead><tr>`;
                const tableText = range.toString().split("\n");
                const delimiter = tableText[0].split(",").length > tableText[0].split("\t").length ? "," : "\t";

                tableText.forEach((rows, index) => {
                    if (index === 0) {
                        rows.split(delimiter).forEach((header, subIndex) => {
                            if (subIndex === 0) {
                                tableHTML += `<th>${header}<wbr></th>`;
                            } else {
                                tableHTML += `<th>${header}</th>`;
                            }
                        });
                        tableHTML += "</tr></thead>";
                    } else {
                        if (index === 1) {
                            tableHTML += "<tbody><tr>";
                        } else {
                            tableHTML += "<tr>";
                        }
                        rows.split(delimiter).forEach((cell) => {
                            tableHTML += `<td>${cell}</td>`;
                        });
                        tableHTML += `</tr>`;
                    }
                });
                tableHTML += "</tbody></table>";
                document.execCommand("insertHTML", false, tableHTML);
                setRangeByWbr(vditor.wysiwyg.element, range);
            }
            useHighlight = false;
            actionBtn.classList.add("vditor-menu--disabled");
        } else if (commandName === "line") {
            if (blockElement) {
                const hrHTML = '<hr data-block="0"><p data-block="0"><wbr>\n</p>';
                if (blockElement.innerHTML.trim() === "") {
                    blockElement.outerHTML = hrHTML;
                } else {
                    blockElement.insertAdjacentHTML("afterend", hrHTML);
                }
                setRangeByWbr(vditor.wysiwyg.element, range);
            }
        } else {
            // bold, italic, strike
            useHighlight = false;
            actionBtn.classList.add("vditor-menu--current");

            if (commandName === "strike") {
                commandName = "strikeThrough";
            }
            if (range.toString() === "" && (commandName === "bold" || commandName === "italic" || commandName === "strikeThrough")) {
                let tagName = "strong";
                if (commandName === "italic") {
                    tagName = "em";
                } else if (commandName === "strikeThrough") {
                    tagName = "s";
                }
                const node = document.createElement(tagName);
                node.textContent = Constants.ZWSP;

                range.insertNode(node);

                if (node.previousSibling && node.previousSibling.textContent === Constants.ZWSP) {
                    // 移除多层嵌套中的 zwsp
                    node.previousSibling.textContent = "";
                }

                range.setStart(node.firstChild, 1);
                range.collapse(true);
                setSelectionFocus(range);
            } else {
                execInlineKeepSelection(vditor, commandName);
            }
        }
    }

    if (useHighlight) {
        highlightToolbarWYSIWYG(vditor);
    }

    if (useRender) {
        afterRenderEvent(vditor);
    }
};
