/**
 * 文本偏移定位纯函数：selection.ts 的选区偏移快照体系（captureSelectionOffsets
 * ↔ setRangeByEditorTextOffset）的定位核心。
 *
 * 口径约定：长度数组由调用方喂入，本模块不做任何过滤；selection.ts 管道喂入
 * 的是 strip-ZWSP 后的长度（ZWSP 为光标辅助/边界噪声，不计入偏移）。注意与
 * getEditorTextOffset（不过滤 ZWSP）口径不同，两套体系勿混用。
 */

/** 定位结果：第 index 个文本节点内的局部偏移 local */
export interface TextOffsetPosition {
    index: number;
    local: number;
}

/** 边界归属偏向：同一数值偏移在节点边界处落到前节点末尾还是后节点开头 */
export type TextOffsetBias = "start" | "end";

export const totalTextLength = (lengths: number[]): number => {
    return lengths.reduce((sum, len) => sum + len, 0);
};

/**
 * 把全局文本偏移解析为文本节点序号 + 局部偏移。
 *
 * 边界语义：offset 恰落在节点边界时按 bias 归属——'end'（默认）归前节点
 * 末尾，与 Range.setEnd 的等价位置约定一致；'start' 归后节点开头，与
 * Range.setStart 一致（选区 start 端点前归属会使恢复的选区漂移进前一块，
 * 曾致列表幂等取消吸并相邻段落，见 fork issue #10）。总长末尾无后续
 * 节点，start 偏向也归末节点末尾。零长文本节点不作为落点。
 * offset clamp 到 [0, 总长]；不存在任何非零文本节点时返回 null
 * （调用方需兜底）。
 */
export const locateTextOffset = (
    lengths: number[],
    offset: number,
    bias: TextOffsetBias = "end",
): TextOffsetPosition | null => {
    let last = -1;
    for (let i = 0; i < lengths.length; i++) {
        if (lengths[i] > 0) {
            last = i;
        }
    }
    if (last === -1) {
        return null;
    }

    const total = totalTextLength(lengths);
    const target = Math.min(Math.max(offset, 0), total);
    if (Number.isNaN(target)) {
        // 非法偏移（NaN 经 clamp 传播）：与旧契约一致返回 null 交调用方兜底，
        // 而非静默归末节点末尾
        return null;
    }

    let prefix = 0;
    for (let i = 0; i < lengths.length; i++) {
        const len = lengths[i];
        if (len === 0) {
            continue;
        }
        if (target < prefix + len || (bias === "end" && target === prefix + len)) {
            return { index: i, local: target - prefix };
        }
        prefix += len;
    }
    // start 偏向落在总长末尾：无后续节点可归属，落末节点末尾
    return { index: last, local: lengths[last] };
};
