import {Constants} from "../constants";
import {ENTER_LINE_BREAK_KEY, getGlobalLocalStorageSetting} from "./globalLocalStorageSettings";
import {recordHistoryChange, recordHistoryPosition} from "./instantHistory";
import {setSelectionFocus} from "./selection";

/** Swap Enter / Shift+Enter only in prose paragraphs; structural blocks own their keys. */
export const handleEnterLineBreak = (vditor: IVditor, event: KeyboardEvent, range: Range): boolean => {
    if (event.key !== "Enter" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
        getGlobalLocalStorageSetting<boolean>(ENTER_LINE_BREAK_KEY, false) !== true) {
        return false;
    }
    const root = vditor.currentMode === "ir" ? vditor.ir.element : vditor.wysiwyg.element;
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer as Element : range.startContainer.parentElement;
    const paragraph = element?.closest("p");
    if (!paragraph || paragraph.parentElement !== root || !paragraph.contains(range.endContainer) ||
        element.closest('[contenteditable="false"], [data-type="inline-math"], [data-type="html-inline"]')) {
        return false;
    }
    // Flush pending typing (including the initial document snapshot) before the split.
    const wasCollapsed = range.collapsed;
    recordHistoryPosition(vditor);
    if (wasCollapsed) {
        range.collapse(true);
    }
    setSelectionFocus(range);
    if (event.shiftKey) {
        // Use the browser's paragraph split (and the editor's input pipeline), even though
        // the physical key is Shift+Enter, whose native default would insert a line break.
        if (!document.execCommand("insertParagraph")) {
            return false;
        }
    } else {
        range.deleteContents();
        const text = document.createTextNode("\n" + Constants.ZWSP);
        range.insertNode(text);
        range.setStart(text, 1);
        range.collapse(true);
        setSelectionFocus(range);
        recordHistoryChange(vditor);
    }
    event.preventDefault();
    return true;
};
