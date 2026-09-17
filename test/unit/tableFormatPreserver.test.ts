import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    preserveTableFormat,
} from '../../src/service/markdown/tableFormatPreserver.ts';

/**
 * 表格格式保鲜器契约
 *
 * 语义：webview 经 Lute 序列化的新内容写盘前，与磁盘旧内容逐表格比对——
 * 内容骨架未变的表格整块还原为磁盘原文（横线数、空格 padding 字节级保留）；
 * 内容骨架变了的表格接受新内容（Lute 规范化）。
 *
 * 拒绝语义：任何解析/对位拿不准的场景一律采用新内容（宁可格式化，绝不丢内容）。
 *
 * 背景：Lute 的 VditorIRDOM2Md / VditorDOM2Md 按列显示宽重新生成分隔行
 * （ir 稳态 = max宽+2，wysiwyg 稳态 = max宽，两模式互不为不动点），
 * 表格 DOM 不携带原文格式信息，导致未编辑的表格在每次保存时被静默重排。
 */

/** 文档骨架：文字 + 两个手工格式的表格 */
const OLD_DOC = [
    '# 标题',
    '',
    '前置段落',
    '',
    '| alpha | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '中间文字',
    '',
    '| x | y |',
    '| --- | --- |',
    '| 7 | 8 |',
    '',
    '结尾',
].join('\n');

/** 模拟 ir 链重排（横线 = 列显示宽 + 2，数据行按列宽补空格），内容不变 */
const LUTE_IR_REWRITE = OLD_DOC
    .replace('| alpha | b |', '| alpha | b |')
    .replace('| - | - |', '| ------- | --- |')
    .replace('| 1 | 2 |', '| 1       | 2   |')
    .replace('| --- | --- |', '| ------- | ----- |')
    .replace('| x | y |', '| x       | y     |')
    .replace('| 7 | 8 |', '| 7       | 8     |');

/** 模拟 wysiwyg 链重排（横线 = 列显示宽，第二表压成 1 横线），内容不变 */
const LUTE_WYS_REWRITE = OLD_DOC
    .replace('| - | - |', '| ----- | - |')
    .replace('| 1 | 2 |', '| 1     | 2 |')
    .replace('| --- | --- |', '| - | - |')
    .replace('| x | y |', '| x     | y |')
    .replace('| 7 | 8 |', '| 7     | 8 |');

describe('preserveTableFormat — 核心契约：未动表格字节级还原', () => {

    it('ir 稳态重排注入（横线拉长+空格对齐）时输出与旧文档逐字节相同', () => {
        assert.equal(preserveTableFormat(OLD_DOC, LUTE_IR_REWRITE), OLD_DOC);
    });

    it('wysiwyg 稳态重排注入（横线压缩）时输出与旧文档逐字节相同', () => {
        assert.equal(preserveTableFormat(OLD_DOC, LUTE_WYS_REWRITE), OLD_DOC);
    });

    it('表格内仅改空格/横线数（内容未变）还原为原文', () => {
        const old = '| a | b |\n| --- | --- |\n| 1 | 2 |';
        const cosmeticOnly = '| a | b |\n| - | - |\n| 1 | 2 |';
        assert.equal(preserveTableFormat(old, cosmeticOnly), old);
    });

    it('表格前的空行数量随表格还原（Lute 会补足双空行）', () => {
        const old = '段落\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n尾段';
        // 真实 Lute 形态：表格前被补成双空行，横线与 padding 重排
        const luteForm = '段落\n\n\n| a | b |\n| ----- | --- |\n| 1     | 2 |\n\n尾段';
        assert.equal(preserveTableFormat(old, luteForm), old);
    });

    it('表格后的空行数量随表格还原（Lute 会把 ≥2 空行压缩为 1）', () => {
        const old = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n\n尾段';
        const luteForm = '| a | b |\n| ----- | --- |\n| 1     | 2 |\n\n尾段';
        assert.equal(preserveTableFormat(old, luteForm), old);
    });

    it('文档尾部换行紧随表格时随表格还原', () => {
        const old = '| a | b |\n| --- | --- |\n| 1 | 2 |';
        const luteForm = '| a | b |\n| ----- | --- |\n| 1     | 2 |\n';
        // 表格是最后一块：尾换行并入 trailing 空行随表格还原，字节级 == old
        assert.equal(preserveTableFormat(old, luteForm), old);
    });

    it('相同输入为恒等变换', () => {
        assert.equal(preserveTableFormat(OLD_DOC, OLD_DOC), OLD_DOC);
    });

    it('幂等：二阶保鲜与一阶结果一致（多面板 echo 检查依赖此性质）', () => {
        const once = preserveTableFormat(OLD_DOC, LUTE_IR_REWRITE);
        assert.equal(preserveTableFormat(OLD_DOC, once), once);
    });

    it('CRLF 旧文本与 LF 新文本同口径处理', () => {
        const old = '| a | b |\r\n| --- | --- |\r\n| 1 | 2 |';
        const rewritten = '| a | b |\n| - | - |\n| 1 | 2 |';
        // \r 剥除后骨架等 → 还原为 LF 形态的原文（宿主链路统一 LF）
        assert.equal(preserveTableFormat(old, rewritten), '| a | b |\n| --- | --- |\n| 1 | 2 |');
    });

});

describe('preserveTableFormat — 编辑场景裁决', () => {

    it('表格外的文字编辑：仅文字变化，全部表格保持旧格式', () => {
        const edited = LUTE_IR_REWRITE.replace('中间文字', '中间文字（已编辑）');
        const out = preserveTableFormat(OLD_DOC, edited);
        assert.equal(out, OLD_DOC.replace('中间文字', '中间文字（已编辑）'));
    });

    it('编辑某表格单元格：该表格接受新格式，其余表格保持旧格式', () => {
        const edited = LUTE_IR_REWRITE.replace('| 1       | 2   |', '| 1       | 999 |');
        const out = preserveTableFormat(OLD_DOC, edited);
        // 第二个表格（未动）必须是旧格式
        assert.ok(out.includes('| x | y |\n| --- | --- |\n| 7 | 8 |'),
            '未编辑的第二个表格应保持旧格式');
        // 第一个表格（已编辑）保留新格式
        assert.ok(out.includes('| ------- | --- |'), '已编辑的表格接受 Lute 规范化');
        assert.ok(!out.includes('| - | - |'), '已编辑表格不应还原旧分隔行');
    });

    it('表格增删数据行（行数变化）判为已编辑', () => {
        const old = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
        const rowDeleted = '| a | b |\n| - | - |\n| 1 | 2 |';
        assert.equal(preserveTableFormat(old, rowDeleted), rowDeleted);
    });

    it('对齐冒号语义变化（--- → --:）判为已编辑', () => {
        const old = '| a | b |\n| --- | --- |\n| 1 | 2 |';
        const realigned = '| a | b |\n| --: | --- |\n| 1 | 2 |';
        assert.equal(preserveTableFormat(old, realigned), realigned);
    });

    it('中部新增表格：新表格保留新格式，两侧已有表格保持旧格式', () => {
        const withNewTable = LUTE_IR_REWRITE.replace(
            '中间文字',
            '中间文字\n\n| 新 | 表 |\n| --- | --- |\n| n | m |',
        );
        const out = preserveTableFormat(OLD_DOC, withNewTable);
        assert.ok(out.includes('| alpha | b |\n| - | - |\n| 1 | 2 |'),
            '新增表格前方的未动表格应保持旧格式');
        assert.ok(out.includes('| x | y |\n| --- | --- |\n| 7 | 8 |'),
            '新增表格后方的未动表格应保持旧格式');
        assert.ok(out.includes('| 新 | 表 |\n| --- | --- |\n| n | m |'),
            '新表格应保留新内容（Lute 格式）');
    });

    it('删除表格：删除生效，其余表格保持旧格式', () => {
        const tableRemoved = LUTE_IR_REWRITE
            .replace('| x       | y     |\n| ------- | ----- |\n| 7       | 8     |\n\n', '');
        const out = preserveTableFormat(OLD_DOC, tableRemoved);
        assert.ok(!out.includes('| x |'), '被删除的表格不应复活');
        assert.ok(out.includes('| alpha | b |\n| - | - |\n| 1 | 2 |'),
            '未删除的表格应保持旧格式');
    });

    it('中段结构错位（增删并存）时保守采用新内容', () => {
        const old = 'a\n\n| h | h2 |\n| --- | --- |\n| 1 | 2 |\n\n| j | k |\n| --- | --- |\n| 3 | 4 |\n\nb';
        // 同时删一个表、把另一个表内容改掉：对位不可靠 → 整段取 new
        const restructured = 'a\n\n| h | h2 |\n| - | - |\n| 9 | 2 |\n\nb';
        assert.equal(preserveTableFormat(old, restructured), restructured);
    });

});

describe('preserveTableFormat — 表格识别边界', () => {

    it('围栏代码块内的伪表格行不参与表格切分（字节保留）', () => {
        const old = [
            '| a | b |',
            '| --- | --- |',
            '| 1 | 2 |',
            '',
            '```markdown',
            '| x | y |',
            '| --- | --- |',
            '```',
            '',
            '尾行',
        ].join('\n');
        // 围栏外表格被 Lute 重排，围栏内必须原样
        const rewritten = old
            .replace('| --- | --- |\n| 1 | 2 |', '| ----- | ----- |\n| 1     | 2     |');
        const out = preserveTableFormat(old, rewritten);
        assert.ok(out.includes('```markdown\n| x | y |\n| --- | --- |\n```'),
            '围栏内的伪表格不应被切分或改写');
        assert.equal(out, old);
    });

    it('波浪线围栏（~~~）同样跳过', () => {
        const old = '~~~\n| a | b |\n| --- | --- |\n~~~\n\n| c | d |\n| --- | --- |\n| 1 | 2 |';
        const rewritten = '~~~\n| a | b |\n| --- | --- |\n~~~\n\n| c | d |\n| - | - |\n| 1 | 2 |';
        assert.equal(preserveTableFormat(old, rewritten), old);
    });

    it('缩进 4 空格及以上的行不判为表格', () => {
        const old = '段落\n\n    | a | b |\n    | --- | --- |\n    | 1 | 2 |\n\n尾';
        const rewritten = '段落（改）\n\n    | a | b |\n    | - | - |\n    | 1 | 2 |\n\n尾';
        const out = preserveTableFormat(old, rewritten);
        // 深缩进行按普通文本处理：不触发骨架还原（| --- | 未被还原为分歧证据），
        // 字节以新内容为准
        assert.ok(out.includes('    | a | b |\n    | - | - |'),
            '4 缩进行按文本处理，未被表格保鲜还原');
        assert.equal(out, rewritten);
    });

    it('含 \\| 转义管道的表格：Lute 去转义前空格属内容级微损，判已编辑取新', () => {
        // 真实 Lute 序列化形态：`a \| b` → `a\| b`（渲染文本少一个空格）。
        // 空格按内容处理（宁可格式化绝不丢内容），一次性落盘后二阶稳态
        const old = '| a \\| b | c |\n| --- | --- |\n| 1 | 2 |';
        const luteForm = '| a\\| b | c |\n| ----- | --- |\n| 1     | 2 |';
        assert.equal(preserveTableFormat(old, luteForm), luteForm);
    });

    it('无分隔行的孤行管道文本不是表格（不抛异常、按文本处理）', () => {
        const old = '| 孤行 | 没有 | 分隔行 |';
        assert.equal(preserveTableFormat(old, '| 孤行 | 没有 | 分隔行 |'), old);
        const edited = '| 孤行 | 没有 | 变化 |';
        assert.equal(preserveTableFormat(old, edited), edited);
    });

    it('CJK 表格：内容等价的格式重排被还原', () => {
        const old = '| 中文表头 | b |\n| --- | --- |\n| 数据 | 2 |';
        const rewritten = '| 中文表头 | b |\n| -------- | --- |\n| 数据     | 2 |';
        assert.equal(preserveTableFormat(old, rewritten), old);
    });

    it('空输入与极端输入不抛异常', () => {
        assert.equal(preserveTableFormat('', ''), '');
        assert.equal(preserveTableFormat('', '| a |\n| - |\n| 1 |'), '| a |\n| - |\n| 1 |');
        assert.equal(preserveTableFormat('| a |\n| - |\n| 1 |', ''), '');
    });

    it('两个骨架相同的表格：编辑其一时另一个仍正确还原', () => {
        const twin = '| a | b |\n| --- | --- |\n| 1 | 2 |';
        const old = `前\n\n${twin}\n\n中\n\n${twin}\n\n后`;
        const editedSecond = old.replace('中\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
            '中\n\n| a | b |\n| - | - |\n| 1 | 9 |');
        const out = preserveTableFormat(old, editedSecond);
        // 第一个表格（未动）保持旧格式；第二个（编辑）取新格式
        assert.ok(out.startsWith('前\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n中'));
        assert.ok(out.includes('中\n\n| a | b |\n| - | - |\n| 1 | 9 |\n\n后'));
    });

    it('文档开头的表格（无前导块）可还原', () => {
        const old = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n正文';
        const rewritten = '| a | b |\n| ----- | --- |\n| 1     | 2 |\n\n正文';
        assert.equal(preserveTableFormat(old, rewritten), old);
    });

    it('单列表格与开放式（无尾管道）写法可还原', () => {
        const old = '| a |\n| --- |\n| 1 |';
        const rewritten = '| a |\n| ----- |\n| 1     |';
        assert.equal(preserveTableFormat(old, rewritten), old);
        const open = '| a | b\n| --- | ---\n| 1 | 2';
        const openRewritten = '| a | b\n| ----- | ---\n| 1     | 2';
        assert.equal(preserveTableFormat(open, openRewritten), open);
    });

    it('分隔行带尾随空格不影响识别', () => {
        const old = '| a | b |  \n| --- | --- |  \n| 1 | 2 |';
        const rewritten = '| a | b |\n| ----- | --- |\n| 1     | 2 |';
        assert.equal(preserveTableFormat(old, rewritten), old);
    });

    it('表格前后允许 ≤3 空格缩进（GFM 规则）', () => {
        const old = ' | a | b |\n | --- | --- |\n | 1 | 2 |';
        const rewritten = ' | a | b |\n | ----- | --- |\n | 1     | 2 |';
        assert.equal(preserveTableFormat(old, rewritten), old);
    });

});
