import { execAfterRender } from "../util/fixBrowserBehavior";
import { setSelectionFocus } from "../util/selection";
import { telemetry } from "../util/telemetry";
import { renderTocNow } from "../util/toc";
import {
    getHeadingRows,
    resolveOutlineDrop,
    wouldReorder,
    type IOutlineBlockDescriptor,
    type IOutlineMovePlan,
    type OutlineDropPosition,
} from "./sectionIndex";
import { pinOutlineActive } from "./updateOutlineActive";

const ITEM_SELECTOR = "span[data-target-id]";
/** 本面板发起拖拽的自定义 MIME：dragover/drop 仅识别它，外来拖放（如编辑器选中文字）不触发重排 */
const DRAG_MIME = "application/x-vditor-outline";
const DRAG_SOURCE_CLASS = "vditor-outline__item--dragging";
const DROP_ABOVE_CLASS = "vditor-outline__item--drop-above";
const DROP_BELOW_CLASS = "vditor-outline__item--drop-below";
const DROP_CLASSES = [DROP_ABOVE_CLASS, DROP_BELOW_CLASS];

const getHeadingLevel = (element: Element): number | null => {
    const match = /^H([1-6])$/.exec(element.tagName);
    return match ? Number(match[1]) : null;
};

interface IOutlineBlockSnapshot {
    blocks: IOutlineBlockDescriptor[];
    elements: HTMLElement[];
    rows: number[];
}

/** 编辑器根直接子元素快照（标题判定与 outlineRender 枚举同一规则：直接子级 H1-H6） */
const snapshotEditorBlocks = (editor: HTMLElement): IOutlineBlockSnapshot => {
    const elements = Array.from(editor.children) as HTMLElement[];
    const blocks: IOutlineBlockDescriptor[] = elements.map((element) => {
        return { level: getHeadingLevel(element) };
    });
    return { blocks, elements, rows: getHeadingRows(blocks) };
};

const findRowByHeading = (snapshot: IOutlineBlockSnapshot, heading: HTMLElement): number => {
    const elementIndex = snapshot.elements.indexOf(heading);
    return elementIndex === -1 ? -1 : snapshot.rows.indexOf(elementIndex);
};

const computeMovePlan = (vditor: IVditor, draggedHeading: HTMLElement, targetHeading: HTMLElement,
    position: OutlineDropPosition): { plan: IOutlineMovePlan; elements: HTMLElement[] } | null => {
    const editor = vditor[vditor.currentMode].element;
    if (!editor.contains(draggedHeading) || !editor.contains(targetHeading)) {
        return null;
    }
    const snapshot = snapshotEditorBlocks(editor);
    const dragRow = findRowByHeading(snapshot, draggedHeading);
    const targetRow = findRowByHeading(snapshot, targetHeading);
    if (dragRow === -1 || targetRow === -1) {
        return null;
    }
    const plan = resolveOutlineDrop(snapshot.blocks, dragRow, targetRow, position);
    if (!plan || !wouldReorder(snapshot.blocks, plan)) {
        return null;
    }
    return { plan, elements: snapshot.elements };
};

/**
 * 按行 id 在当前编辑器根的直接子级中解析标题元素。
 * 不用 document.getElementById：同页多编辑器（或文档内其他元素）可能持有相同 id，
 * 全局查找会命中外部元素导致拖拽静默失效。
 */
const findHeadingById = (editor: HTMLElement, id: string): HTMLElement | null => {
    const matched = Array.from(editor.children).find((element) => element.id === id);
    return matched === undefined ? null : matched as HTMLElement;
};

/** 文档顺序的下一大纲行（行嵌套在 ul/li 树中，不能用 nextElementSibling） */
const nextOutlineRow = (contentElement: HTMLElement, row: HTMLElement): HTMLElement | null => {
    const rows = Array.from(contentElement.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
    const index = rows.indexOf(row);
    return index === -1 || index + 1 >= rows.length ? null : rows[index + 1];
};

/** 行是否处于折叠子树内（outlineRender 折叠时对子树 ul 写 display:none） */
const isRowHidden = (row: HTMLElement): boolean => {
    return !!row.closest('ul[style*="display: none"], ul[style*="display:none"]');
};

/**
 * 将被拖标题的整个治理区域移动到目标标题边界，并按块拖拽（blockHandle）的
 * 成熟配方提交：DOM 移动 → renderTocNow → 记 undo → 触发序列化与保存。
 * 返回是否真实发生了移动。
 */
export const applyOutlineSectionMove = (vditor: IVditor, draggedHeading: HTMLElement, targetHeading: HTMLElement,
    position: OutlineDropPosition): boolean => {
    const editor = vditor[vditor.currentMode].element;
    const computed = computeMovePlan(vditor, draggedHeading, targetHeading, position);
    if (!computed) {
        return false;
    }
    const { plan, elements } = computed;
    const sectionElements = elements.slice(plan.start, plan.end);
    const reference = plan.insertBefore === null ? null : elements[plan.insertBefore];
    sectionElements.forEach((element) => {
        if (reference) {
            editor.insertBefore(element, reference);
        } else {
            editor.appendChild(element);
        }
    });

    // 光标定位到被移动标题（同 blockHandle 移块后的焦点处理）：
    // undo 快照由此携带 <wbr> 光标标记，回退后光标落回被移动标题
    const caretRange = document.createRange();
    caretRange.selectNodeContents(draggedHeading);
    caretRange.collapse(true);
    setSelectionFocus(caretRange);

    // 提交顺序与 blockHandle 块拖拽一致：先重建大纲、记录 undo，
    // 再触发渲染/输入链（enableAddUndoStack:false 防止 undo 双记）
    renderTocNow(vditor);
    vditor.undo.addToUndoStack(vditor);
    execAfterRender(vditor, {
        enableAddUndoStack: false,
        enableHint: false,
        enableInput: true,
    });
    telemetry(vditor, "markdown.outline.move", {
        position,
        blocks: plan.end - plan.start,
    });

    // 移动后定位：高亮被移动标题并让其大纲行滚入视野（id 在重建后已被刷新，读取最新值）
    pinOutlineActive(vditor, draggedHeading.id);
    const outlineRow = vditor.outline.element.querySelector(
        `span[data-target-id="${CSS.escape(draggedHeading.id)}"]`);
    if (outlineRow) {
        (outlineRow as HTMLElement).scrollIntoView({ block: "nearest" });
    }
    return true;
};

interface IOutlineDragState {
    /** 持元素引用而非 id：outlineRender 每次渲染按位置重编号标题 id，拖拽中途重建不使拖拽对象漂移 */
    draggedHeading: HTMLElement | null;
    indicatedRow: HTMLElement | null;
}

/**
 * 在大纲面板内容容器上绑定一次拖拽重排（委托绑定，面板重建 innerHTML 不失效）。
 * 仅桌面鼠标场景（HTML5 DnD，触屏不触发）。
 */
export const bindOutlineDrag = (vditor: IVditor, contentElement: HTMLElement) => {
    if (contentElement.dataset.outlineDragBound === "true") {
        return;
    }
    contentElement.dataset.outlineDragBound = "true";
    const state: IOutlineDragState = {
        draggedHeading: null,
        indicatedRow: null,
    };

    const rowOf = (target: EventTarget | null): HTMLElement | null => {
        return target instanceof Element
            ? (target.closest(ITEM_SELECTOR) as HTMLElement | null)
            : null;
    };

    const clearIndicators = () => {
        if (state.indicatedRow) {
            state.indicatedRow.classList.remove(...DROP_CLASSES);
            state.indicatedRow = null;
        }
    };

    const clearDragVisuals = () => {
        contentElement.querySelectorAll(`.${DRAG_SOURCE_CLASS}`).forEach((element) => {
            element.classList.remove(DRAG_SOURCE_CLASS);
        });
        contentElement.querySelectorAll("[draggable]").forEach((element) => {
            element.removeAttribute("draggable");
        });
        clearIndicators();
    };

    // HTML5 拖拽要求拖动手势开始前元素已标记 draggable：mousedown 时临时标记
    contentElement.addEventListener("mousedown", (event: MouseEvent) => {
        const row = rowOf(event.target);
        if (!row) {
            return;
        }
        contentElement.querySelectorAll("[draggable]").forEach((element) => {
            element.removeAttribute("draggable");
        });
        row.setAttribute("draggable", "true");
    });

    contentElement.addEventListener("dragstart", (event: DragEvent) => {
        const row = rowOf(event.target);
        const draggedId = row?.getAttribute("data-target-id");
        const editor = vditor[vditor.currentMode].element;
        const draggedHeading = draggedId ? findHeadingById(editor, draggedId) : null;
        if (!row || !event.dataTransfer || !draggedHeading) {
            event.preventDefault();
            return;
        }
        state.draggedHeading = draggedHeading;
        // text/plain 供外部接收（编辑器 drop 只消费 DROP_EDITOR/Files/text/html，拖入正文为安全无操作）；
        // 自定义 MIME 供本面板识别自己的拖拽
        event.dataTransfer.setData("text/plain", draggedId);
        event.dataTransfer.setData(DRAG_MIME, draggedId);
        event.dataTransfer.effectAllowed = "move";
        row.classList.add(DRAG_SOURCE_CLASS);
    });

    const resolveRowDrop = (event: DragEvent):
        { row: HTMLElement; position: OutlineDropPosition; draggedHeading: HTMLElement; targetHeading: HTMLElement }
        | null => {
        if (!state.draggedHeading || !event.dataTransfer
            || !event.dataTransfer.types.includes(DRAG_MIME)) {
            return null;
        }
        const row = rowOf(event.target);
        const targetId = row?.getAttribute("data-target-id");
        if (!row || !targetId) {
            return null;
        }
        const editor = vditor[vditor.currentMode].element;
        const draggedHeading = state.draggedHeading;
        // 拖拽中编辑器 DOM 被整体替换/删除该标题（如 AI 流式重写）时安全失效，不猜测对应关系
        if (!editor.contains(draggedHeading)) {
            return null;
        }
        const targetHeading = findHeadingById(editor, targetId);
        if (!targetHeading) {
            return null;
        }
        const rect = row.getBoundingClientRect();
        // 矩形高度为 0（无布局环境/测试）时按上方处理，保持行为确定
        const position: OutlineDropPosition = rect.height > 0 && (event.clientY - rect.top) >= rect.height / 2
            ? "below"
            : "above";
        return { row, position, draggedHeading, targetHeading };
    };

    contentElement.addEventListener("dragover", (event: DragEvent) => {
        if (!event.dataTransfer) {
            return;
        }
        const drop = resolveRowDrop(event);
        if (!drop || !computeMovePlan(vditor, drop.draggedHeading, drop.targetHeading, drop.position)) {
            event.dataTransfer.dropEffect = "none";
            clearIndicators();
            return;
        }
        // 仅在可落点 preventDefault，浏览器才会派发 drop
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        clearIndicators();
        // 指示线锚定「插入边界」而非悬停行的半区：悬停某行下半与悬停下一行上半
        // 渲染同一根线（画在下一行顶部）；文档末尾（无下一行）或下一行被折叠
        // 隐藏时，回退到悬停行底部
        if (drop.position === "above") {
            state.indicatedRow = drop.row;
            drop.row.classList.add(DROP_ABOVE_CLASS);
        } else {
            const nextRow = nextOutlineRow(contentElement, drop.row);
            if (nextRow && !isRowHidden(nextRow)) {
                state.indicatedRow = nextRow;
                nextRow.classList.add(DROP_ABOVE_CLASS);
            } else {
                state.indicatedRow = drop.row;
                drop.row.classList.add(DROP_BELOW_CLASS);
            }
        }
    });

    contentElement.addEventListener("dragleave", (event: DragEvent) => {
        if (!event.relatedTarget || !contentElement.contains(event.relatedTarget as Node)) {
            clearIndicators();
        }
    });

    contentElement.addEventListener("drop", (event: DragEvent) => {
        const drop = resolveRowDrop(event);
        // 移动会立即重建大纲（dragend 将落在脱离文档的节点上不再冒泡），此处先行清理状态
        state.draggedHeading = null;
        clearIndicators();
        if (!drop) {
            return;
        }
        if (applyOutlineSectionMove(vditor, drop.draggedHeading, drop.targetHeading, drop.position)) {
            event.preventDefault();
        }
    });

    contentElement.addEventListener("dragend", () => {
        state.draggedHeading = null;
        clearDragVisuals();
    });
};
