/**
 * 大纲拖拽重排的纯逻辑（无 DOM 依赖，供单测与 dragReorder 共用）。
 *
 * 输入是编辑器根直接子元素的顺序快照：level=1..6 为标题块，null 为普通块。
 * 语义契约（坚决不少移、不多移）：
 * - 标题治理区域 [start,end)：从标题起到下一个「层级 ≤ 自身」的标题之前
 * - 插入永远锚定标题边界：above=目标标题前 / below=文档顺序下一个标题前（末行=文档末尾）
 * - 插入点严格落在被拖区域内部 → 拒绝；原位/等价位置 → wouldReorder 为 false
 */
export interface IOutlineBlockDescriptor {
    /** 标题层级 1-6；null 为非标题块 */
    level: number | null;
}

export type OutlineDropPosition = "above" | "below";

export interface IOutlineMovePlan {
    /** 被拖区域在原始子元素序列中的索引区间 [start, end) */
    start: number;
    end: number;
    /** 插到原始序列中该子元素之前；null = 追加文档末尾 */
    insertBefore: number | null;
}

export const isOutlineHeadingBlock = (block: IOutlineBlockDescriptor): boolean => {
    return block.level !== null;
};

export const getHeadingRows = (blocks: IOutlineBlockDescriptor[]): number[] => {
    const rows: number[] = [];
    blocks.forEach((block, index) => {
        if (isOutlineHeadingBlock(block)) {
            rows.push(index);
        }
    });
    return rows;
};

export const getSectionRange = (blocks: IOutlineBlockDescriptor[], headingIndex: number):
    { start: number; end: number } => {
    const level = blocks[headingIndex]?.level;
    if (level === null || level === undefined) {
        return { start: headingIndex, end: headingIndex };
    }
    let end = headingIndex + 1;
    while (end < blocks.length) {
        const next = blocks[end].level;
        if (next !== null && next <= level) {
            break;
        }
        end += 1;
    }
    return { start: headingIndex, end };
};

export const resolveOutlineDrop = (blocks: IOutlineBlockDescriptor[], dragRow: number, targetRow: number,
    position: OutlineDropPosition): IOutlineMovePlan | null => {
    const rows = getHeadingRows(blocks);
    if (dragRow < 0 || dragRow >= rows.length || targetRow < 0 || targetRow >= rows.length) {
        return null;
    }
    const { start, end } = getSectionRange(blocks, rows[dragRow]);
    let insertBefore: number | null;
    if (position === "above") {
        insertBefore = rows[targetRow];
    } else {
        insertBefore = targetRow + 1 < rows.length ? rows[targetRow + 1] : null;
    }
    if (insertBefore !== null && start < insertBefore && insertBefore < end) {
        // 插入点落在被拖区域内部：无法自嵌
        return null;
    }
    return { start, end, insertBefore };
};

/** 模拟裁剪+插入后序列是否变化，用于过滤原位/等价无操作 */
export const wouldReorder = (blocks: IOutlineBlockDescriptor[], plan: IOutlineMovePlan): boolean => {
    const order = blocks.map((_block, index) => index);
    const cut = order.splice(plan.start, plan.end - plan.start);
    let insertAt = order.length;
    if (plan.insertBefore !== null) {
        // 插入点前被裁剪掉的元素数需要钳位（插入点不在被拖区域内，已由 resolveOutlineDrop 保证）
        const removedBefore = Math.max(0, Math.min(plan.end, plan.insertBefore) - plan.start);
        insertAt = plan.insertBefore - removedBefore;
    }
    order.splice(insertAt, 0, ...cut);
    return order.some((value, index) => value !== index);
};
