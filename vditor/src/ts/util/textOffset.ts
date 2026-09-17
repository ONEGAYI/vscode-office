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

export const totalTextLength = (lengths: number[]): number => {
    return lengths.reduce((sum, len) => sum + len, 0);
};

/**
 * 把全局文本偏移解析为文本节点序号 + 局部偏移。
 *
 * 边界语义：offset 恰落在节点边界时归属前一个节点的末尾，与
 * Range.setStart(node, node.length) 的等价位置约定一致；零长文本节点
 * 不作为落点。offset clamp 到 [0, 总长]；不存在任何非零文本节点时
 * 返回 null（调用方需兜底）。
 */
export const locateTextOffset = (lengths: number[], offset: number): TextOffsetPosition | null => {
    let hasText = false;
    for (const len of lengths) {
        if (len > 0) {
            hasText = true;
            break;
        }
    }
    if (!hasText) {
        return null;
    }

    const total = totalTextLength(lengths);
    const target = Math.min(Math.max(offset, 0), total);

    let prefix = 0;
    for (let i = 0; i < lengths.length; i++) {
        const len = lengths[i];
        if (len === 0) {
            continue;
        }
        if (target <= prefix + len) {
            return { index: i, local: target - prefix };
        }
        prefix += len;
    }
    // clamp 后必在循环内命中，此处仅为类型完备
    return null;
};
