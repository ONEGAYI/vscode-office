import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getHeadingRows,
  getSectionRange,
  resolveOutlineDrop,
  wouldReorder,
  type IOutlineBlockDescriptor,
} from '../../vditor/src/ts/outline/sectionIndex.ts';

/**
 * 大纲拖拽重排的纯逻辑契约（feat/outline-drag-reorder）
 *
 * 块描述：编辑器根直接子元素的顺序快照，level=1..6 为标题、null 为普通块。
 * 语义契约：
 * - 标题治理区域 [start,end)：从标题起到下一个「层级 ≤ 自身」的标题前
 * - 插入锚定标题边界；插入点严格落在被拖区域内部 → 拒绝（null）
 * - 原位/等价位置 → wouldReorder 为 false（执行层跳过）
 */

/** H(x) 生成标题描述，p 生成普通块描述 */
const doc = (spec: string): IOutlineBlockDescriptor[] =>
  spec.split(/\s+/).filter(Boolean).map((token) => {
    const m = /^(h([1-6])|p)$/.exec(token.toLowerCase());
    if (!m) throw new Error(`bad token: ${token}`);
    return { level: m[1] === 'p' ? null : Number(m[2]) };
  });

// 文档 A：preamble + H1(带正文) + H2(带两段正文) + H1(带正文)
const DOC_A = 'p h1 p h2 p p h1 p';
// 文档 B：层级跳跃 H1 → H3 → H2
const DOC_B = 'h1 h3 h2';
// 文档 C：同级相邻标题 + 尾随正文
const DOC_C = 'h1 h1 p';

describe('getHeadingRows / getSectionRange', () => {
  it('A：三个标题行，区域按「层级 ≤ 自身」截断', () => {
    const blocks = doc(DOC_A);
    assert.deepEqual(getHeadingRows(blocks), [1, 3, 6]);
    assert.deepEqual(getSectionRange(blocks, 1), { start: 1, end: 6 });
    assert.deepEqual(getSectionRange(blocks, 3), { start: 3, end: 6 });
    assert.deepEqual(getSectionRange(blocks, 6), { start: 6, end: 8 });
  });

  it('B：层级跳跃时 h1 治理到文档末尾，h3/h2 各自独立', () => {
    const blocks = doc(DOC_B);
    assert.deepEqual(getHeadingRows(blocks), [0, 1, 2]);
    assert.deepEqual(getSectionRange(blocks, 0), { start: 0, end: 3 });
    assert.deepEqual(getSectionRange(blocks, 1), { start: 1, end: 2 });
    assert.deepEqual(getSectionRange(blocks, 2), { start: 2, end: 3 });
  });

  it('C：同级相邻标题区域互斥不重叠', () => {
    const blocks = doc(DOC_C);
    assert.deepEqual(getSectionRange(blocks, 0), { start: 0, end: 1 });
    assert.deepEqual(getSectionRange(blocks, 1), { start: 1, end: 3 });
  });

  it('无标题文档返回空行集', () => {
    assert.deepEqual(getHeadingRows(doc('p p p')), []);
  });
});

describe('resolveOutlineDrop / wouldReorder', () => {
  it('上方插入：整段移到目标标题前（preamble 之后）', () => {
    const blocks = doc(DOC_A);
    // 拖 H2 行(row1, 区域[3,6)) 放 H1 行(row0) 上方 → 插到索引 1（preamble 与 H1 之间）
    const plan = resolveOutlineDrop(blocks, 1, 0, 'above');
    assert.deepEqual(plan, { start: 3, end: 6, insertBefore: 1 });
    assert.equal(wouldReorder(blocks, plan!), true);
  });

  it('插入点在被拖区域内部 → 拒绝', () => {
    const blocks = doc(DOC_A);
    // 拖 H1(row0, 区域[1,6)) 放自己子标题 H2(row1) 上方 → 插到 3，严格落在 (1,6) 内
    assert.equal(resolveOutlineDrop(blocks, 0, 1, 'above'), null);
    // 拖 H1 放 H2 下方 → 插到 rows[2]=6 恰为区域右边界：合法但等价原位
    const noop = resolveOutlineDrop(blocks, 0, 1, 'below');
    assert.deepEqual(noop, { start: 1, end: 6, insertBefore: 6 });
    assert.equal(wouldReorder(blocks, noop!), false);
  });

  it('下方插入：锚定文档顺序下一个标题', () => {
    const blocks = doc(DOC_A);
    // 拖第二段 H1(row2, 区域[6,8)) 放 H1 行(row0) 下方 → 插到 rows[1]=3（H2 标题前）
    const plan = resolveOutlineDrop(blocks, 2, 0, 'below');
    assert.deepEqual(plan, { start: 6, end: 8, insertBefore: 3 });
    assert.equal(wouldReorder(blocks, plan!), true);
  });

  it('末行下方：追加文档末尾', () => {
    const blocks = doc(DOC_A);
    const plan = resolveOutlineDrop(blocks, 0, 2, 'below');
    assert.deepEqual(plan, { start: 1, end: 6, insertBefore: null });
    assert.equal(wouldReorder(blocks, plan!), true);
  });

  it('原位与等价位置判定为无操作', () => {
    const blocks = doc(DOC_A);
    // 自身上方 = 原位
    const self = resolveOutlineDrop(blocks, 2, 2, 'above');
    assert.deepEqual(self, { start: 6, end: 8, insertBefore: 6 });
    assert.equal(wouldReorder(blocks, self!), false);
    // 末行自身下方 = 追加末尾 = 原位
    const tail = resolveOutlineDrop(blocks, 2, 2, 'below');
    assert.equal(wouldReorder(blocks, tail!), false);
    // 相邻前移一位（插入点=区域起点）等价无操作
    const b = doc(DOC_B);
    const adj = resolveOutlineDrop(b, 1, 0, 'below');
    assert.deepEqual(adj, { start: 1, end: 2, insertBefore: 1 });
    assert.equal(wouldReorder(b, adj!), false);
  });

  it('层级跳跃文档：h2 可移入 h1 区域内，h1 不可移入自身', () => {
    const b = doc(DOC_B);
    // 拖 h2(row2) 放 h3(row1) 上方 → 插到 1，h1(row0) 前方区域内合法
    const plan = resolveOutlineDrop(b, 2, 1, 'above');
    assert.deepEqual(plan, { start: 2, end: 3, insertBefore: 1 });
    assert.equal(wouldReorder(b, plan!), true);
    // 拖 h1(row0, 区域[0,3)) 放 h3(row1) 上方 → 插到 1 严格落在 (0,3) 内 → 拒绝
    assert.equal(resolveOutlineDrop(b, 0, 1, 'above'), null);
  });

  it('行号越界返回 null', () => {
    const blocks = doc(DOC_A);
    assert.equal(resolveOutlineDrop(blocks, -1, 0, 'above'), null);
    assert.equal(resolveOutlineDrop(blocks, 0, 3, 'below'), null);
    assert.equal(resolveOutlineDrop(doc('p p'), 0, 0, 'above'), null);
  });
});
