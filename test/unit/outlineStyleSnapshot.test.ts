import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutlineStyleSnapshot } from '../../vditor/src/ts/outline/styleSnapshot.ts';

/**
 * 大纲条目标式快照的纯逻辑契约（feat/outline-drag-reorder 功能 2）
 *
 * 偏差式透传：仅当标题计算值与编辑器根计算值不同才注入；
 * font-size 与 font-weight 一律排除（大纲保留自身层级字号体系；标题层级
 * 字重不进大纲，行内真实加粗由 strong/b 标签直通 + UA 默认样式呈现）。
 */

const FULL_DEFAULTS = {
  'color': 'rgb(187, 187, 187)',
  'background-color': 'rgba(0, 0, 0, 0)',
  'font-family': 'Segoe UI, sans-serif',
  'font-size': '32px',
  'font-style': 'normal',
  'font-weight': '700',
  'text-decoration-line': 'none',
  'text-decoration-style': 'solid',
  'text-decoration-color': 'rgb(187, 187, 187)',
};

describe('buildOutlineStyleSnapshot', () => {
  it('无偏差时返回空字符串（不注入任何样式）', () => {
    assert.equal(buildOutlineStyleSnapshot(FULL_DEFAULTS, FULL_DEFAULTS), '');
  });

  it('CSS 控制的颜色偏差被透传，font-size 永不透传', () => {
    const snapshot = buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'color': 'rgb(255, 0, 0)', 'font-size': '48px' },
      FULL_DEFAULTS,
    );
    assert.equal(snapshot, 'color: rgb(255, 0, 0);');
  });

  it('透明背景不注入；真实背景偏差注入', () => {
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'background-color': 'transparent' },
      FULL_DEFAULTS,
    ), '');
    // 标题透明而编辑器根有底色：透明值仍不注入（避免无效样式噪声）
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'background-color': 'rgba(0, 0, 0, 0)' },
      { ...FULL_DEFAULTS, 'background-color': 'rgb(255, 255, 0)' },
    ), '');
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'background-color': 'rgb(255, 235, 59)' },
      FULL_DEFAULTS,
    ), 'background-color: rgb(255, 235, 59);');
  });

  it('font-weight 恒不透传（标题层级字重不进大纲，行内加粗靠标签直通）', () => {
    // 600 是编辑器主题对 h1-h6 的实际设定值（_reset.less），曾使全部条目呈半粗体
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'font-weight': '600' }, FULL_DEFAULTS,
    ), '');
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'font-weight': '700' }, FULL_DEFAULTS,
    ), '');
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'font-weight': 'bold' }, FULL_DEFAULTS,
    ), '');
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'font-weight': '400' }, FULL_DEFAULTS,
    ), '');
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'font-weight': '800' }, FULL_DEFAULTS,
    ), '');
  });

  it('font-style 仅非 normal 时注入', () => {
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'font-style': 'normal' }, FULL_DEFAULTS,
    ), '');
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'font-style': 'italic' }, FULL_DEFAULTS,
    ), 'font-style: italic;');
  });

  it('text-decoration 偏差注入且输出顺序确定', () => {
    const snapshot = buildOutlineStyleSnapshot(
      {
        ...FULL_DEFAULTS,
        'color': 'rgb(1, 2, 3)',
        'font-style': 'italic',
        'text-decoration-line': 'underline',
      },
      FULL_DEFAULTS,
    );
    assert.equal(snapshot, 'color: rgb(1, 2, 3); font-style: italic; text-decoration-line: underline;');
  });

  it('font-family 偏差透传（CSS 控制的标题字体）', () => {
    assert.equal(buildOutlineStyleSnapshot(
      { ...FULL_DEFAULTS, 'font-family': '"Cascadia Code", monospace' },
      FULL_DEFAULTS,
    ), 'font-family: "Cascadia Code", monospace;');
  });

  it('空计算值一律跳过（jsdom 等环境）', () => {
    const empty = Object.fromEntries(Object.keys(FULL_DEFAULTS).map((k) => [k, '']));
    assert.equal(buildOutlineStyleSnapshot(empty, FULL_DEFAULTS), '');
    assert.equal(buildOutlineStyleSnapshot(FULL_DEFAULTS, empty), '');
  });
});
