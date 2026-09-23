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

const getTextEnd = (node: Text) => {
    let end = node.data.length;
    while (end > 0 && /[\s\u200b]/.test(node.data[end - 1])) {
        end--;
    }
    return end;
};

const getLastTextRect = (definition: HTMLElement, cache: Map<HTMLElement, Text>): DOMRect => {
    let lastText = cache.get(definition) || null;
    let lastEnd = lastText && definition.contains(lastText) ? getTextEnd(lastText) : 0;
    if (lastEnd === 0) {
        lastText = null;
        const walker = document.createTreeWalker(definition, NodeFilter.SHOW_TEXT);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
            const end = getTextEnd(node);
            if (end > 0) {
                lastText = node;
                lastEnd = end;
            }
        }
        if (lastText) cache.set(definition, lastText);
        else cache.delete(definition);
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
    const lastTextNodes = new Map<HTMLElement, Text>();
    const lastReferences = new Map<string, { element: HTMLElement; index: number }>();
    const findReferences = (label: string) => Array.from(
        editorElement.querySelectorAll<HTMLElement>(REFERENCE_SELECTOR),
    ).filter((reference) => normalizeLabel(reference.getAttribute("data-footnotes-label") || "") === label);
    const resizeObserver = typeof ResizeObserver === "function"
        ? new ResizeObserver(() => queueUpdate(1)) : null;

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
            const textRect = getLastTextRect(definition, lastTextNodes);
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
                lastTextNodes.delete(definition);
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
    let pendingUpdate = -1;
    let lastScrollHeight = editorElement.scrollHeight;
    // 0: 只在内容高度变化时定位；1: 强制定位；2: 脚注结构变化，重新同步按钮。
    const queueUpdate = (level: number) => {
        if (level < 2 && buttons.size === 0) {
            return;
        }
        pendingUpdate = Math.max(pendingUpdate, level);
        if (updateFrame) {
            return;
        }
        updateFrame = requestAnimationFrame(() => {
            updateFrame = 0;
            const levelToApply = pendingUpdate;
            pendingUpdate = -1;
            const scrollHeight = editorElement.scrollHeight;
            const heightChanged = scrollHeight !== lastScrollHeight;
            lastScrollHeight = scrollHeight;
            // 短文档被编辑区最小高度撑住：上方换行会移动脚注，但 scrollHeight 不变。
            const shortEditor = vditor.options.height !== "auto"
                && scrollHeight <= editorElement.clientHeight;
            if (levelToApply === 2) {
                syncButtons();
            } else if (levelToApply === 1 || heightChanged
                || (levelToApply === 0 && shortEditor)) {
                positionButtons();
            }
        });
    };
    const containsFootnoteStructure = (node: Node) => node instanceof Element
        && (node.matches(FOOTNOTE_STRUCTURE_SELECTOR) || !!node.querySelector(FOOTNOTE_STRUCTURE_SELECTOR));
    const observer = new MutationObserver((records) => {
        let level = 0;
        for (const record of records) {
            if (record.type === "attributes") {
                if ((record.target as Element).closest(FOOTNOTE_STRUCTURE_SELECTOR)) {
                    level = 2;
                }
                continue;
            }
            if (record.type === "characterData") {
                const parent = record.target.parentElement;
                const definition = parent?.closest<HTMLElement>(DEFINITION_SELECTOR);
                if (definition) {
                    lastTextNodes.delete(definition);
                    level = Math.max(level, parent === definition ? 2 : 1);
                } else if (parent?.closest(REFERENCE_SELECTOR)) {
                    level = 2;
                }
                continue;
            }
            const definition = (record.target as Element).closest?.<HTMLElement>(DEFINITION_SELECTOR);
            if (definition) {
                lastTextNodes.delete(definition);
                level = 2;
                continue;
            }
            if ((record.target as Element).closest?.(REFERENCE_SELECTOR)
                || Array.from(record.addedNodes).some(containsFootnoteStructure)
                || Array.from(record.removedNodes).some(containsFootnoteStructure)) {
                level = 2;
                continue;
            }
            if (Array.from(record.addedNodes).some((node) => node.nodeType === Node.ELEMENT_NODE)
                || Array.from(record.removedNodes).some((node) => node.nodeType === Node.ELEMENT_NODE)) {
                level = Math.max(level, 1);
            }
        }
        queueUpdate(level);
    });
    observer.observe(editorElement, { childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ["data-marker", "data-footnotes-label"] });
    const onLayoutChange = () => queueUpdate(1);
    editorElement.addEventListener("scroll", onLayoutChange, { passive: true });
    window.addEventListener("resize", onLayoutChange);
    document.fonts?.addEventListener("loadingdone", onLayoutChange);
    resizeObserver?.observe(editorElement);
    const styleObserver = new MutationObserver(onLayoutChange);
    styleObserver.observe(document.head, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["href", "media"] });
    queueUpdate(2);

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
            lastTextNodes.clear();
            lastReferences.clear();
        },
    };
};
