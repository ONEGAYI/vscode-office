import { pinOutlineActive } from "../outline/updateOutlineActive";
import { buildOutlineStyleSnapshot, collectComputedStyleSource } from "../outline/styleSnapshot";
import { closeMobileOutline, isEditorThemeMobileLayout } from "../ui/mobileOutlineMenu";
import { codicon } from "../util/codicon";
import { hasClosestByHeadings } from "../util/hasClosestByHeadings";
import { mathRender } from "./mathRender";

const stripIrOutlineMarkers = (element: HTMLElement) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".vditor-ir__marker, wbr").forEach((node) => {
        node.remove();
    });
    return clone;
};

const escapeOutlineCodeHTML = (element: HTMLElement) => {
    element.querySelectorAll("code").forEach((codeElement) => {
        codeElement.innerHTML = codeElement.innerHTML.replace(/&/g, "&amp;");
    });
    return element;
};

/** 直通内容的纵深防御：剥离 on* 事件属性（编辑器 DOM 入口已过 Lute sanitize，此处仅兜底） */
const stripEventAttributes = (element: HTMLElement) => {
    element.querySelectorAll("*").forEach((node) => {
        Array.from(node.attributes).forEach(({name}) => {
            if (name.length > 2 && name.toLowerCase().startsWith("on")) {
                node.removeAttribute(name);
            }
        });
    });
    return element;
};

/** 标题克隆（ir 剥离 marker/wbr）：innerHTML 作为条目直通内容，outerHTML 喂 Lute 生成结构 */
const getOutlineHeadingClone = (item: HTMLElement, vditor?: IVditor) => {
    const clone = vditor?.currentMode === "ir" ? stripIrOutlineMarkers(item) : item.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("wbr").forEach((node) => {
        node.remove();
    });
    return clone;
};

export const OUTLINE_SCROLL_OFFSET = 15;
const OUTLINE_ACTIVE_MAX_OFFSET = 120;
const OUTLINE_ACTIVE_VIEWPORT_RATIO = 0.25;

export const getOutlineActiveReferenceY = (vditor: IVditor, contentElement: HTMLElement) => {
    const contentRect = contentElement.getBoundingClientRect();
    let visibleTop = contentRect.top;
    let visibleBottom = contentRect.bottom;

    if (vditor.options.height === "auto") {
        visibleBottom = window.innerHeight;
        if (vditor.options.toolbarConfig.pin) {
            visibleTop = Math.max(visibleTop, vditor.toolbar.element.getBoundingClientRect().bottom);
        }
    }

    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const activeOffset = Math.max(
        OUTLINE_SCROLL_OFFSET,
        Math.min(OUTLINE_ACTIVE_MAX_OFFSET, visibleHeight * OUTLINE_ACTIVE_VIEWPORT_RATIO),
    );
    return visibleTop + activeOffset;
};

export const scrollOutlineTarget = (scrollElement: HTMLElement, idElement: HTMLElement) => {
    const scrollRect = scrollElement.getBoundingClientRect();
    const targetRect = idElement.getBoundingClientRect();
    scrollElement.scrollTop += targetRect.top - scrollRect.top - OUTLINE_SCROLL_OFFSET;
};

export const outlineRender = (contentElement: HTMLElement, targetElement: Element, vditor?: IVditor) => {
    let tocHTML = "";
    const ids: string[] = [];
    // 条目内容（剥离 marker 的克隆 innerHTML）与元素级样式快照，与 ids 按下标对齐
    const itemContents: string[] = [];
    const styleSnapshots: string[] = [];
    const canComputeStyles = !!vditor && typeof getComputedStyle === "function";
    const baseStyleSource = canComputeStyles
        ? collectComputedStyleSource(getComputedStyle(contentElement))
        : null;
    Array.from(contentElement.children).forEach((item: HTMLElement, index: number) => {
        if (hasClosestByHeadings(item)) {
            if (vditor) {
                if (!item.id) {
                    item.id = `vditor-outline-target-${index}`;
                } else {
                    const lastIndex = item.id.lastIndexOf("_");
                    item.id = item.id.substring(0, lastIndex === -1 ? undefined : lastIndex) + "_" + index;
                }
            }
            ids.push(item.id);
            const clone = getOutlineHeadingClone(item, vditor);
            // 直通内容不经 Lute 往返：innerHTML 赋值自带一次实体解析，不预转义（否则 & 双重转义）
            itemContents.push(stripEventAttributes(clone).innerHTML);
            // 喂 Lute 的路径需对 code 内 & 预转义，补偿 Lute 往返的一次反转义（基线行为）
            tocHTML += escapeOutlineCodeHTML(clone).outerHTML;
            // 偏差式透传：标题被 CSS 控制时仅注入与编辑器根不同的属性（font-size 恒不透传）
            if (baseStyleSource) {
                styleSnapshots.push(buildOutlineStyleSnapshot(
                    collectComputedStyleSource(getComputedStyle(item)),
                    baseStyleSource,
                ));
            } else {
                styleSnapshots.push("");
            }
        }
    });
    if (tocHTML === "") {
        targetElement.innerHTML = "";
        return "";
    }
    const tempElement = document.createElement("div");
    if (vditor) {
        vditor.lute.SetToC(true);
        if (vditor.currentMode === "wysiwyg") {
            tempElement.innerHTML = vditor.lute.SpinVditorDOM("<p>[ToC]</p>" + tocHTML);
        } else {
            tempElement.innerHTML = vditor.lute.HTML2VditorDOM("<p>[ToC]</p>" + tocHTML);
        }
        vditor.lute.SetToC(vditor.options.preview.markdown.toc);
    } else {
        targetElement.classList.add("vditor-outline");
        const lute = Lute.New();
        lute.SetToC(true);
        tempElement.innerHTML = lute.HTML2VditorDOM("<p>[ToC]</p>" + tocHTML);
    }
    const tocRoot = tempElement.firstElementChild;
    if (!tocRoot) {
        targetElement.innerHTML = "";
        return "";
    }
    const headingsElement = tocRoot.querySelectorAll("li > span[data-target-id]");
    // Lute 的 ToC 输出与标题数对齐时，条目内容以克隆为准（ir 路径 Lute 会丢弃 <s> 等行内标签）
    const useClonedContents = headingsElement.length === itemContents.length;
    headingsElement.forEach((item, index) => {
        if (item.nextElementSibling && item.nextElementSibling.tagName === "UL") {
            const iconHTML = codicon("chevron-down", "vditor-outline__action");
            item.innerHTML = `${iconHTML}<span>${item.innerHTML}</span>`;
        } else {
            item.innerHTML = `<span class="vditor-outline__placeholder" aria-hidden="true"></span><span>${item.innerHTML}</span>`;
        }
        const contentSpan = item.lastElementChild;
        if (useClonedContents && contentSpan) {
            contentSpan.innerHTML = itemContents[index];
            if (styleSnapshots[index]) {
                contentSpan.setAttribute("style", styleSnapshots[index]);
            }
        }
        item.setAttribute("data-target-id", ids[index]);
    });
    tocHTML = tocRoot.innerHTML;
    if (headingsElement.length === 0) {
        targetElement.innerHTML = "";
        return tocHTML;
    }
    targetElement.innerHTML = tocHTML;
    if (vditor) {
        mathRender(targetElement as HTMLElement, {
            cdn: vditor.options.cdn,
            math: vditor.options.preview.math,
        });
    }
    const cacheId = vditor?.options?.cache?.id;
    const storageKey = cacheId ? `vditor-outline-state:${cacheId}` : null;

    const loadCollapsedState = (): Set<string> => {
        if (!storageKey) return new Set();
        try {
            const raw = localStorage.getItem(storageKey);
            return raw ? new Set(JSON.parse(raw)) : new Set();
        } catch {
            return new Set();
        }
    };

    const saveCollapsedState = () => {
        if (!storageKey) return;
        const collapsed: string[] = [];
        targetElement.querySelectorAll(".vditor-outline__action--close").forEach((el) => {
            const id = (el.parentElement?.getAttribute("data-target-id"));
            if (id) collapsed.push(id);
        });
        localStorage.setItem(storageKey, JSON.stringify(collapsed));
    };

    // restore collapse state
    const collapsedIds = loadCollapsedState();
    if (collapsedIds.size > 0) {
        targetElement.querySelectorAll("li > span[data-target-id]").forEach((span) => {
            const id = span.getAttribute("data-target-id");
            if (!id || !collapsedIds.has(id)) return;
            const action = span.querySelector(".vditor-outline__action");
            const sibling = span.parentElement?.querySelector("ul");
            if (action && sibling) {
                action.classList.add("vditor-outline__action--close");
                (sibling as HTMLElement).style.display = "none";
            }
        });
    }

    targetElement.firstElementChild?.addEventListener("click", (event: Event) => {
        let target = event.target as HTMLElement;
        while (target && !target.isEqualNode(targetElement)) {
            if (target.classList.contains("vditor-outline__action")) {
                if (target.classList.contains("vditor-outline__action--close")) {
                    target.classList.remove("vditor-outline__action--close");
                    target.parentElement.nextElementSibling.setAttribute("style", "display:block");
                } else {
                    target.classList.add("vditor-outline__action--close");
                    target.parentElement.nextElementSibling.setAttribute("style", "display:none");
                }
                saveCollapsedState();
                event.preventDefault();
                event.stopPropagation();
                break;
            } else if (target.getAttribute("data-target-id")) {
                event.preventDefault();
                event.stopPropagation();
                const targetId = target.getAttribute("data-target-id");
                const idElement = document.getElementById(targetId);
                if (!idElement) {
                    return;
                }
                if (vditor) {
                    pinOutlineActive(vditor, targetId);
                    if (vditor.options.height === "auto") {
                        let windowScrollY = idElement.offsetTop + vditor.element.offsetTop;
                        if (!vditor.options.toolbarConfig.pin) {
                            windowScrollY += vditor.toolbar.element.offsetHeight;
                        }
                        window.scrollTo(window.scrollX, windowScrollY - OUTLINE_SCROLL_OFFSET);
                    } else {
                        if (vditor.element.offsetTop < window.scrollY) {
                            window.scrollTo(window.scrollX, vditor.element.offsetTop);
                        }
                        scrollOutlineTarget(contentElement, idElement);
                    }
                    if (isEditorThemeMobileLayout(vditor)) {
                        closeMobileOutline(vditor);
                    }
                } else {
                    window.scrollTo(window.scrollX, idElement.offsetTop - OUTLINE_SCROLL_OFFSET);
                }
                break;
            }
            target = target.parentElement;
        }
    });
    return tocHTML;
};
