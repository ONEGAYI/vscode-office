import {getMarkdown} from "../markdown/getMarkdown";
import {fireContentInput} from "../util/saveToolbarState";
import {removeCurrentToolbar} from "../toolbar/setToolbar";
import {accessLocalStorage} from "../util/compatibility";
import {saveCacheFocus} from "../util/cacheFocus";
import {clearHistoryInputBuffer} from "../util/historyInputBufferState";
import {listToggle} from "../util/fixBrowserBehavior";
import {hasClosestBlock, hasClosestByAttribute, hasClosestByClassName, hasClosestByMatchTag} from "../util/hasClosest";
import {getEditorRange, setRangeByWbr, setSelectionFocus, captureSelectionOffsets, restoreSelectionOffsets, EditorSelectionSnapshot} from "../util/selection";
import {getHistoryMaxWaitFactor, getHistoryRecordWait} from "../util/historySchedule";
import {scheduleRenderToc} from "../util/toc";
import {highlightToolbarIR} from "./highlightToolbarIR";
import {input} from "./input";

export const processHint = (vditor: IVditor) => {
    vditor.hint.render(vditor);
};

export const recordHistory = (vditor: IVditor, options = {
    enableAddUndoStack: true,
    enableHint: false,
    enableInput: true,
}) => {
    if (vditor.ir.composingLock) {
        return;
    }
    const text = getMarkdown(vditor);
    if (options.enableInput) {
        fireContentInput(vditor, text);
    }

    if (vditor.options.counter.enable) {
        vditor.counter.render(vditor, text);
    }

    if (vditor.options.cache.enable && accessLocalStorage()) {
        localStorage.setItem(vditor.options.cache.id, text);
        saveCacheFocus(vditor);
        if (vditor.options.cache.after) {
            vditor.options.cache.after(text);
        }
    }

    if (options.enableAddUndoStack) {
        vditor.undo.addToUndoStack(vditor);
    }

    if (vditor.options.outline.enable) {
        scheduleRenderToc(vditor);
    }

    vditor.ir.afterRenderLastAt = Date.now();
    clearHistoryInputBuffer(vditor);
};

export const processAfterRender = (vditor: IVditor, options = {
    enableAddUndoStack: true,
    enableHint: false,
    enableInput: true,
}) => {
    if (options.enableHint) {
        processHint(vditor);
    }

    clearTimeout(vditor.ir.processTimeoutId);
    const wait = getHistoryRecordWait(
        vditor.ir.afterRenderLastAt,
        vditor.options.undoDelay,
        getHistoryMaxWaitFactor(vditor),
    );
    vditor.ir.processTimeoutId = window.setTimeout(() => {
        recordHistory(vditor, options);
    }, wait);
};

export const processHeading = (vditor: IVditor, value: string) => {
    const range = getEditorRange(vditor);
    const headingElement = hasClosestBlock(range.startContainer) || range.startContainer as HTMLElement;
    if (headingElement) {
        const headingMarkerElement = headingElement.querySelector(".vditor-ir__marker--heading");
        if (headingMarkerElement) {
            headingMarkerElement.innerHTML = value;
        } else {
            headingElement.insertAdjacentText("afterbegin", value);
            range.selectNodeContents(headingElement);
            range.collapse(false);
        }
        input(vditor, range.cloneRange());
        highlightToolbarIR(vditor);
    }
};

const removeInline = (range: Range, vditor: IVditor, type: string) => {
    const inlineElement = hasClosestByAttribute(range.startContainer, "data-type", type) as HTMLElement;
    if (inlineElement) {
        inlineElement.firstElementChild.remove();
        inlineElement.lastElementChild.remove();
        range.insertNode(document.createElement("wbr"));
        const tempElement = document.createElement("div");
        tempElement.innerHTML = vditor.lute.SpinVditorIRDOM(inlineElement.outerHTML);
        inlineElement.outerHTML = tempElement.firstElementChild.innerHTML.trim();
    }
};

/** 取消内联样式并保留选区：首 marker 在选区之前被摘除，端点各左移 marker 长度 */
const removeInlineKeepSelection = (vditor: IVditor, range: Range, type: string, markerLength: number) => {
    const savedSelection = captureSelectionOffsets(vditor);
    removeInline(range, vditor, type);
    // 失败时 removeInline 插入的 wbr 由函数尾 setRangeByWbr 兜底
    restoreSelectionOffsets(vditor, savedSelection, -markerLength);
};

export const processToolbar = (vditor: IVditor, actionBtn: Element, prefix: string, suffix: string) => {
    const range = getEditorRange(vditor);
    const commandName = actionBtn.getAttribute("data-type");
    let typeElement = range.startContainer as HTMLElement;
    if (typeElement.nodeType === 3) {
        typeElement = typeElement.parentElement;
    }
    let useHighlight = true;
    // 移除
    if (actionBtn.classList.contains("vditor-menu--current")) {
        if (commandName === "quote") {
            const quoteElement = hasClosestByMatchTag(typeElement, "BLOCKQUOTE");
            if (quoteElement) {
                const savedSelection = captureSelectionOffsets(vditor);
                range.insertNode(document.createElement("wbr"));
                quoteElement.outerHTML = quoteElement.innerHTML.trim() === "" ?
                    `<p data-block="0">${quoteElement.innerHTML}</p>` : quoteElement.innerHTML;
                // 恢复失败时保留 wbr，由函数尾统一 setRangeByWbr 兜底
                restoreSelectionOffsets(vditor, savedSelection);
            }
        } else if (commandName === "link") {
            const aElement = hasClosestByAttribute(range.startContainer, "data-type", "a") as HTMLElement;
            if (aElement) {
                const aTextElement = hasClosestByClassName(range.startContainer, "vditor-ir__link");
                if (aTextElement) {
                    range.insertNode(document.createElement("wbr"));
                    aElement.outerHTML = aTextElement.innerHTML;
                } else {
                    aElement.outerHTML = aElement.querySelector(".vditor-ir__link").innerHTML + "<wbr>";
                }
            }
        } else if (commandName === "italic") {
            removeInlineKeepSelection(vditor, range, "em", 1);
        } else if (commandName === "bold") {
            removeInlineKeepSelection(vditor, range, "strong", 2);
        } else if (commandName === "strike") {
            removeInlineKeepSelection(vditor, range, "s", 2);
        } else if (commandName === "inline-code") {
            removeInlineKeepSelection(vditor, range, "code", 1);
        } else if (commandName === "check" || commandName === "list" || commandName === "ordered-list") {
            listToggle(vditor, range, commandName);
            useHighlight = false;
            actionBtn.classList.remove("vditor-menu--current");
        }
    } else {
        // 添加
        if (vditor.ir.element.childNodes.length === 0) {
            vditor.ir.element.innerHTML = '<p data-block="0"><wbr></p>';
            setRangeByWbr(vditor.ir.element, range);
        }
        const blockElement = hasClosestBlock(range.startContainer);
        if (commandName === "line") {
            if (blockElement) {
                const hrHTML = '<hr data-block="0"><p data-block="0"><wbr>\n</p>';
                if (blockElement.innerHTML.trim() === "") {
                    blockElement.outerHTML = hrHTML;
                } else {
                    blockElement.insertAdjacentHTML("afterend", hrHTML);
                }
            }
        } else if (commandName === "quote") {
            if (blockElement) {
                const savedSelection = captureSelectionOffsets(vditor);
                range.insertNode(document.createElement("wbr"));
                blockElement.outerHTML = `<blockquote data-block="0">${blockElement.outerHTML}</blockquote>`;
                restoreSelectionOffsets(vditor, savedSelection);
                useHighlight = false;
                actionBtn.classList.add("vditor-menu--current");
            }
        } else if (commandName === "link") {
            let html;
            if (range.toString() === "") {
                html = `${prefix}<wbr>${suffix}`;
            } else {
                html = `${prefix}${range.toString()}${suffix.replace(")", "<wbr>)")}`;
            }
            document.execCommand("insertHTML", false, html);
            useHighlight = false;
            actionBtn.classList.add("vditor-menu--current");
        } else if (commandName === "italic" || commandName === "bold" || commandName === "strike"
            || commandName === "inline-code" || commandName === "code" || commandName === "table") {
            let html;
            // 内联标记插入平移选区偏移（如 ** 前缀使选中内容整体后移）
            let savedSelection: EditorSelectionSnapshot = null;
            let markerShift = 0;
            if (range.toString() === "") {
                html = `${prefix}<wbr>${suffix}`;
            } else {
                if (commandName === "code" || commandName === "table") {
                    html = `${prefix}${range.toString()}<wbr>${suffix}`;
                } else {
                    html = `${prefix}${range.toString()}${suffix}<wbr>`;
                    savedSelection = captureSelectionOffsets(vditor);
                    markerShift = prefix.length;
                }
                range.deleteContents();
            }
            if (commandName === "table" || commandName === "code") {
                html = "\n" + html + "\n\n";
            }

            const spanElement = document.createElement("span");
            spanElement.innerHTML = html;
            range.insertNode(spanElement);
            input(vditor, range);
            // input() 同步完成 spin 重渲染，此处按平移偏移在新标记节点内重选内容
            restoreSelectionOffsets(vditor, savedSelection, markerShift);

            if (commandName === "table") {
                range.selectNodeContents(getSelection().getRangeAt(0).startContainer.parentElement);
                setSelectionFocus(range);
            }
        } else if (commandName === "check" || commandName === "list" || commandName === "ordered-list") {
            listToggle(vditor, range, commandName, false);
            useHighlight = false;
            removeCurrentToolbar(vditor.toolbar.elements, ["check", "list", "ordered-list"]);
            actionBtn.classList.add("vditor-menu--current");
        }
    }
    setRangeByWbr(vditor.ir.element, range);
    processAfterRender(vditor);
    if (useHighlight) {
        highlightToolbarIR(vditor);
    }
};
