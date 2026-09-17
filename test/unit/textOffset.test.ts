/**
 * 单元测试 — 文本偏移定位纯函数（fix/selection-retention）
 *
 * locateTextOffset 把"编辑器全局文本偏移"解析为 {index, local}：
 * 第 index 个文本节点内的局部偏移 local。长度口径由调用方决定
 * （selection.ts 管道喂入 strip-ZWSP 长度；与 getEditorTextOffset 的
 * 不过滤口径不同，两套体系勿混用），本模块不做过滤。
 *
 * 边界语义：offset 恰落在节点边界时归属前一个节点的末尾（local =
 * lengths[index]），与 Range.setStart(node, node.length) 的等价位置约定
 * 一致。越界 clamp 到 [0, total]；无文本节点时返回 null（调用方兜底）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { locateTextOffset, totalTextLength } from "../../vditor/src/ts/util/textOffset.ts";

describe("locateTextOffset", () => {
    it("单节点内定位", () => {
        assert.deepEqual(locateTextOffset([10], 4), { index: 0, local: 4 });
    });

    it("offset 0 → 首节点起点", () => {
        assert.deepEqual(locateTextOffset([3, 5], 0), { index: 0, local: 0 });
    });

    it("跨节点定位", () => {
        assert.deepEqual(locateTextOffset([3, 5], 5), { index: 1, local: 2 });
        assert.deepEqual(locateTextOffset([3, 5], 3 + 5), { index: 1, local: 5 });
    });

    it("边界偏移归属前一节点末尾", () => {
        assert.deepEqual(locateTextOffset([3, 5], 3), { index: 0, local: 3 });
    });

    it("越界 clamp 到末节点末尾", () => {
        assert.deepEqual(locateTextOffset([3, 5], 100), { index: 1, local: 5 });
    });

    it("负偏移 clamp 到首节点起点", () => {
        assert.deepEqual(locateTextOffset([3, 5], -2), { index: 0, local: 0 });
    });

    it("零长节点（空文本节点）被跳过，边界不落入其后", () => {
        assert.deepEqual(locateTextOffset([3, 0, 5], 3), { index: 0, local: 3 });
        assert.deepEqual(locateTextOffset([3, 0, 5], 4), { index: 2, local: 1 });
    });

    it("空数组 → null（无文本节点可定位）", () => {
        assert.equal(locateTextOffset([], 0), null);
        assert.equal(locateTextOffset([0, 0], 0), null);
    });
});

describe("totalTextLength", () => {
    it("求和", () => {
        assert.equal(totalTextLength([3, 0, 5]), 8);
        assert.equal(totalTextLength([]), 0);
    });
});
