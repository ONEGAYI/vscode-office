import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureContrastColor } from '../../vditor/src/ts/markdown/mermaidTheme.ts';

/**
 * Auto 主题连线色对比契约（diagram popup 连线可读性修复）
 *
 * 背景：vditor 浅色主题的 --second-color 是半透明浅灰（如 rgba(88,96,105,.36)），
 * 被直通为 mermaid lineColor 后在浅底/毛玻璃背衬上对比度远低于图形元素 3:1 底线。
 * 契约：
 * - 输出恒为不透明实色（弹窗毛玻璃、图表容器底色都不再透进连线笔画）
 * - 与背景对比不足时向前景色混合，直到 WCAG 对比度 ≥ 3（图形底线）
 * - 已达标的颜色原样保留（不破坏精心挑选的调色板）
 * - 解析失败时原样返回，不抛错
 */

const LUMINANCE = (r: number, g: number, b: number) => {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
};

const contrast = (a: string, b: string) => {
  const pick = (c: string) => c.match(/(\d+(\.\d+)?)/g)!.slice(0, 3).map(Number) as [number, number, number];
  const [l1, l2] = [a, b].map((c) => {
    const [r, g, b] = pick(c);
    return LUMINANCE(r, g, b);
  });
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const isOpaque = (color: string) => {
  const parts = color.match(/rgba?\(([^)]+)\)/);
  if (!parts) return false;
  const nums = parts[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return nums.length < 4 || nums[3] === 1;
};

describe('ensureContrastColor', () => {
  it('把半透明浅灰连线色实色化并提到 3:1 对比（vditor Github Light 默认值）', () => {
    const out = ensureContrastColor('rgba(88, 96, 105, 0.36)', '#f6f8fa', '#24292e');
    assert.ok(isOpaque(out), `应输出不透明色，实际 ${out}`);
    assert.ok(contrast(out, 'rgb(246, 248, 250)') >= 3, `对比度应 ≥3，实际 ${out}`);
  });

  it('回退 border 色 #d0d0d0 在白底上同样被提深', () => {
    const out = ensureContrastColor('#d0d0d0', '#ffffff', '#333333');
    assert.ok(isOpaque(out), `应输出不透明色，实际 ${out}`);
    assert.ok(contrast(out, 'rgb(255, 255, 255)') >= 3, `对比度应 ≥3，实际 ${out}`);
  });

  it('已达标的不透明颜色原样返回', () => {
    assert.equal(ensureContrastColor('#333333', '#ffffff', '#333333'), '#333333');
  });

  it('深色编辑器主题下半透明浅色被提亮而非压暗', () => {
    const out = ensureContrastColor('rgba(200, 200, 200, 0.4)', '#1e1e1e', '#d4d4d4');
    assert.ok(isOpaque(out), `应输出不透明色，实际 ${out}`);
    assert.ok(contrast(out, 'rgb(30, 30, 30)') >= 3, `对比度应 ≥3，实际 ${out}`);
  });

  it('解析失败的输入原样返回不抛错', () => {
    assert.equal(ensureContrastColor('var(--x)', '', ''), 'var(--x)');
  });
});
