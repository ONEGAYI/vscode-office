import { scrollToBlock } from "./scrollToBlock";

const DEFINITION_SELECTOR = '[data-type="footnotes-def"], [data-type="footnotes-li"]';
const REFERENCE_SELECTOR = '[data-type="footnotes-ref"]';
const FOOTNOTE_STRUCTURE_SELECTOR = `${DEFINITION_SELECTOR}, ${REFERENCE_SELECTOR}, [data-type="footnotes-block"]`;
const BACK_BUTTON_CLASS = "vditor-footnotes__goto-ref";

const normalizeLabel = (label: string) => label.trim().replace(/^\^/, "");

const getDefinitionLabel = (definition: HTMLElement) => {
    const marker = definition.getAttribute("data-marker");
    if (marker) {
        return normalizeLabel(marker);
    }
    return /^\[\^([^\]]+)\]:/.exec(definition.textContent?.trimStart() || "")?.[1] || "";
};

const getLastTextRect = (definition: HTMLElement): DOMRect => {
    const walker = document.createTreeWalker(definition, NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    let lastEnd = 0;
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
        let end = node.data.length;
        while (end > 0 && /[\s\u200b]/.test(node.data[end - 1])) {
            end--;
        }
        if (end > 0) {
            lastText = node;
            lastEnd = end;
        }
    }
    if (!lastText) {
        return definition.getBoundingClientRect();
    }
    const range = document.createRange();
    range.setStart(lastText, lastEnd - 1);
    range.setEnd(lastText, lastEnd);
    const rect = range.getBoundingClientRect();
    return rect.width || rect.height ? rect : definition.getBoundingClientRect();
};

export const initFootnoteBackrefs = (vditor: IVditor, host: HTMLElement) => {
    const editorElement = host.querySelector<HTMLElement>(".vditor-reset")!;
    const buttons = new Map<HTMLElement, HTMLButtonElement>();
    const lastReferences = new Map<string, { element: HTMLElement; index: number }>();
    const findReferences = (label: string) => Array.from(
        editorElement.querySelectorAll<HTMLElement>(REFERENCE_SELECTOR),
    ).filter((reference) => normalizeLabel(reference.getAttribute("data-footnotes-label") || "") === label);
    const resizeObserver = typeof ResizeObserver === "function"
        ? new ResizeObserver(() => queueUpdate(false)) : null;

    const positionButtons = () => {
        if (buttons.size === 0) {
            return;
        }
        const hostRect = host.getBoundingClientRect();
        const editorRect = editorElement.getBoundingClientRect();
        for (const [definition, button] of buttons) {
            if (!editorElement.contains(definition)) {
                button.hidden = true;
                continue;
            }
            const definitionRect = definition.getBoundingClientRect();
            if (definitionRect.bottom < editorRect.top || definitionRect.top > editorRect.bottom) {
                button.hidden = true;
                continue;
            }
            const textRect = getLastTextRect(definition);
            button.hidden = false;
            let left = textRect.right - hostRect.left + 5;
            let top = textRect.top - hostRect.top + (textRect.height - button.offsetHeight) / 2;
            if (left + button.offsetWidth > editorRect.right - hostRect.left - 8) {
                left = Math.max(editorRect.left - hostRect.left + 8, textRect.left - hostRect.left);
                top = textRect.bottom - hostRect.top + 2;
            }
            button.style.left = `${left}px`;
            button.style.top = `${top}px`;
            const buttonRect = button.getBoundingClientRect();
            button.hidden = buttonRect.bottom < editorRect.top || buttonRect.top > editorRect.bottom;
        }
    };

    const syncButtons = () => {
        const referencedLabels = new Set(Array.from(editorElement.querySelectorAll<HTMLElement>(REFERENCE_SELECTOR))
            .map((reference) => normalizeLabel(reference.getAttribute("data-footnotes-label") || "")));
        const definitions = Array.from(editorElement.querySelectorAll<HTMLElement>(DEFINITION_SELECTOR))
            .filter((definition) => {
                const label = getDefinitionLabel(definition);
                return label && referencedLabels.has(label);
            });
        const active = new Set(definitions);
        for (const [definition, button] of buttons) {
            if (!active.has(definition)) {
                resizeObserver?.unobserve(definition);
                button.remove();
                buttons.delete(definition);
            }
        }
        for (const definition of definitions) {
            if (buttons.has(definition)) {
                continue;
            }
            const button = document.createElement("button");
            const backLabel = window.VditorI18n?.footnoteBack || "Back to reference";
            button.type = "button";
            button.className = BACK_BUTTON_CLASS;
            button.textContent = "↩";
            button.setAttribute("aria-label", backLabel);
            button.title = backLabel;
            button.onclick = () => {
                const label = getDefinitionLabel(definition);
                const references = findReferences(label);
                const last = lastReferences.get(label);
                const target = last?.element && editorElement.contains(last.element)
                    ? last.element
                    : references[last?.index ?? 0] || references[0];
                target?.scrollIntoView({ block: "center" });
            };
            host.appendChild(button);
            buttons.set(definition, button);
            resizeObserver?.observe(definition);
        }
        positionButtons();
    };

    let updateFrame = 0;
    let syncNeeded = false;
    const queueUpdate = (sync: boolean) => {
        if (!sync && buttons.size === 0) {
            return;
        }
        syncNeeded ||= sync;
        if (updateFrame) {
            return;
        }
        updateFrame = requestAnimationFrame(() => {
            updateFrame = 0;
            if (syncNeeded) {
                syncNeeded = false;
                syncButtons();
            } else {
                positionButtons();
            }
        });
    };
    const containsFootnoteStructure = (node: Node) => node instanceof Element
        && (node.matches(FOOTNOTE_STRUCTURE_SELECTOR) || !!node.querySelector(FOOTNOTE_STRUCTURE_SELECTOR));
    const observer = new MutationObserver((records) => {
        const needsSync = records.some((record) => {
            if (record.type === "attributes") {
                return true;
            }
            if (record.type === "characterData") {
                return !!record.target.parentElement?.closest(FOOTNOTE_STRUCTURE_SELECTOR);
            }
            if ((record.target as Element).closest?.(FOOTNOTE_STRUCTURE_SELECTOR)) {
                return true;
            }
            return Array.from(record.addedNodes).some(containsFootnoteStructure)
                || Array.from(record.removedNodes).some(containsFootnoteStructure);
        });
        queueUpdate(needsSync);
    });
    observer.observe(editorElement, { childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ["data-marker", "data-footnotes-label"] });
    const onLayoutChange = () => queueUpdate(false);
    editorElement.addEventListener("scroll", onLayoutChange, { passive: true });
    window.addEventListener("resize", onLayoutChange);
    document.fonts?.addEventListener("loadingdone", onLayoutChange);
    resizeObserver?.observe(editorElement);
    const styleObserver = new MutationObserver(onLayoutChange);
    styleObserver.observe(document.head, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["href", "media"] });
    queueUpdate(true);

    return {
        navigate(reference: HTMLElement, rawLabel: string) {
            const label = normalizeLabel(rawLabel);
            if (!scrollToBlock(vditor, `footnote:${rawLabel}`)) {
                return false;
            }
            const references = findReferences(label);
            lastReferences.set(label, { element: reference, index: references.indexOf(reference) });
            positionButtons();
            return true;
        },
        dispose() {
            observer.disconnect();
            styleObserver.disconnect();
            resizeObserver?.disconnect();
            editorElement.removeEventListener("scroll", onLayoutChange);
            window.removeEventListener("resize", onLayoutChange);
            document.fonts?.removeEventListener("loadingdone", onLayoutChange);
            if (updateFrame) {
                cancelAnimationFrame(updateFrame);
            }
            for (const button of buttons.values()) {
                button.remove();
            }
            buttons.clear();
            lastReferences.clear();
        },
    };
};
