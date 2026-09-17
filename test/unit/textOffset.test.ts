/**
 * 单元测试 — 文本偏移定位纯函数（fix/selection-retention，#10 补 start 偏向）
 *
 * locateTextOffset 把"编辑器全局文本偏移"解析为 {index, local}：
 * 第 index 个文本节点内的局部偏移 local。长度口径由调用方决定
 * （selection.ts 管道喂入 strip-ZWSP 长度；与 getEditorTextOffset 的
 * 不过滤口径不同，两套体系勿混用），本模块不做过滤。
 *
 * 边界语义（#10）：offset 恰落在节点边界时的归属由 bias 决定——
 * 'end'（默认）归属前一节点末尾，与 Range.setEnd 的等价位置约定一致；
 * 'start' 归属后一节点开头，与 Range.setStart 一致（选区 start 端点
 * 前归属会使恢复的选区漂移进前一块，曾致列表幂等取消吸并相邻段落）。
 * 总长末尾处无后续节点，start 偏向也归属末节点末尾。越界 clamp 到
 * [0, total]；无文本节点时返回 null（调用方兜底）。
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

    it("end 偏向（默认）：边界偏移归属前一节点末尾", () => {
        assert.deepEqual(locateTextOffset([3, 5], 3), { index: 0, local: 3 });
        assert.deepEqual(locateTextOffset([3, 5], 3, "end"), { index: 0, local: 3 });
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

describe("locateTextOffset start 偏向（#10：选区 start 端点防前漂移）", () => {
    it("边界偏移归属后一节点开头", () => {
        assert.deepEqual(locateTextOffset([3, 5], 3, "start"), { index: 1, local: 0 });
    });

    it("总长末尾无后续节点 → 归属末节点末尾", () => {
        assert.deepEqual(locateTextOffset([3, 5], 8, "start"), { index: 1, local: 5 });
        assert.deepEqual(locateTextOffset([3, 5], 100, "start"), { index: 1, local: 5 });
    });

    it("零长节点跳过后的边界 → 归属其后首个非零节点开头", () => {
        assert.deepEqual(locateTextOffset([3, 0, 5], 3, "start"), { index: 2, local: 0 });
    });

    it("非边界偏移与 end 偏向一致", () => {
        assert.deepEqual(locateTextOffset([3, 5], 5, "start"), { index: 1, local: 2 });
        assert.deepEqual(locateTextOffset([3, 5], 0, "start"), { index: 0, local: 0 });
        assert.deepEqual(locateTextOffset([3, 5], -2, "start"), { index: 0, local: 0 });
    });

    it("空数组 → null（与 end 偏向一致）", () => {
        assert.equal(locateTextOffset([], 0, "start"), null);
        assert.equal(locateTextOffset([0, 0], 0, "start"), null);
    });

    it("NaN 偏移 → null（旧契约：交调用方兜底，不静默归末节点末尾）", () => {
        assert.equal(locateTextOffset([3, 5], Number.NaN), null);
        assert.equal(locateTextOffset([3, 5], Number.NaN, "start"), null);
        assert.equal(locateTextOffset([3, 5], Number.NaN, "end"), null);
    });
});

describe("totalTextLength", () => {
    it("求和", () => {
        assert.equal(totalTextLength([3, 0, 5]), 8);
        assert.equal(totalTextLength([]), 0);
    });
});
