/**
 * 表格格式保鲜器
 *
 * 契约：webview 经 Lute 序列化的新内容写盘前，与磁盘旧内容逐表格比对——
 * 内容骨架（单元格文本 + 列数 + 行数 + 对齐语义）未变的表格，整块还原为磁盘
 * 原文（分隔行横线数、空格 padding 字节级保留）；骨架变了的表格接受新内容
 * （Lute 规范化格式）。
 *
 * 拒绝语义：任何解析/对位拿不准的场景一律采用新内容——宁可格式化，绝不丢内容。
 *
 * 背景：Lute 的 VditorIRDOM2Md / VditorDOM2Md 按列显示宽重新生成分隔行与
 * padding（ir 稳态 = 最大显示宽 + 2，wysiwyg 稳态 = 最大显示宽，两模式互不
 * 为不动点），而表格 DOM 不携带原文格式信息，导致未编辑的表格在每次保存时
 * 被静默重排（fork issue：脏工作区）。本模块在宿主保存链路单点拦截。
 *
 * 本模块刻意不依赖 vscode，保持可单测（对齐 externalChangeGuard 惯例）。
 */

type TextBlock = { kind: 'text'; lines: string[] };
/**
 * 表格块：leadingBlanks 是紧邻表格上方被吸收进来的空行（含只含空白的行）。
 * Lute 序列化会在表格前统一补足双空行（HTML 块隔离习惯），这部分空行与
 * 分隔行/空格 padding 同属表格格式噪音，一并随表格还原。
 */
type TableBlock = { kind: 'table'; leadingBlanks: string[]; lines: string[] };
type Block = TextBlock | TableBlock;

type TableAlign = 'none' | 'left' | 'center' | 'right';

interface TableSkeleton {
    header: string[];
    aligns: TableAlign[];
    rows: string[][];
}

const INDENT_MAX = 3;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const DELIMITER_ROW = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const stripIndent = (line: string): string => {
    const match = /^[ \t]{0,INDENT_MAX}/.exec(line);
    return match ? line.slice(match[0].length) : line;
};

const indentWidthOk = (line: string): boolean => {
    const match = /^[ \t]+/.exec(line);
    return !match || match[0].length <= INDENT_MAX;
};

/** 分隔行：≤3 缩进、含 |（排除 thematic break / setext 下划线）、整列为 :?-+:? 形态 */
const isDelimiterRow = (line: string): boolean =>
    line.includes('|') && DELIMITER_ROW.test(line);

/** 表头候选行：≤3 缩进且含 |（围栏外的任意含管道行） */
const isHeaderCandidate = (line: string): boolean =>
    indentWidthOk(line) && line.includes('|');

/** 把文本切成 text / table 块序列（GFM 管道表格，跳过围栏代码块） */
const splitBlocks = (text: string): Block[] => {
    const lines = text.split('\n');
    const blocks: Block[] = [];
    let textBuf: string[] = [];
    let i = 0;

    const flushText = () => {
        if (textBuf.length > 0) {
            blocks.push({ kind: 'text', lines: textBuf });
            textBuf = [];
        }
    };

    while (i < lines.length) {
        const line = lines[i];
        const stripped = stripIndent(line);
        const fenceMatch = FENCE_OPEN.exec(line);

        if (fenceMatch) {
            // 围栏代码块：整块（含围栏行）按 text 处理，内部伪表格不参与切分
            const fenceChar = fenceMatch[1][0];
            const fenceLen = fenceMatch[1].length;
            const closeRe = new RegExp(`^ {0,3}\\${fenceChar}{${fenceLen},}\\s*$`);
            textBuf.push(line);
            i++;
            while (i < lines.length) {
                textBuf.push(lines[i]);
                if (closeRe.test(lines[i])) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }

        if (isHeaderCandidate(line) && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
            // 表格块：表头 + 分隔行 + 连续的含管道行（空行/无管道/深缩进终止）
            const tableLines = [line, lines[i + 1]];
            let j = i + 2;
            while (j < lines.length && lines[j].includes('|') && indentWidthOk(lines[j])
                && !FENCE_OPEN.test(lines[j])) {
                tableLines.push(lines[j]);
                j++;
            }
            // 吸收紧邻上方的空行：表格前的空行形态（单/双空行）随表格还原
            const leadingBlanks: string[] = [];
            while (textBuf.length > 0 && textBuf[textBuf.length - 1].trim() === '') {
                leadingBlanks.unshift(textBuf.pop()!);
            }
            flushText();
            blocks.push({ kind: 'table', leadingBlanks, lines: tableLines });
            i = j;
            continue;
        }

        textBuf.push(line);
        i++;
    }
    flushText();
    return blocks;
};

/** 按未转义的 | 切列，\| 视为字面量保留（两侧同函数处理，等价性对称） */
const splitRowCells = (line: string): string[] => {
    let row = stripIndent(line).trim();
    if (row.startsWith('|')) {
        row = row.slice(1);
    }
    if (row.endsWith('|') && !row.endsWith('\\|')) {
        row = row.slice(0, -1);
    }
    const cells: string[] = [];
    let cur = '';
    for (let k = 0; k < row.length; k++) {
        if (row[k] === '|' && row[k - 1] !== '\\') {
            cells.push(cur.trim());
            cur = '';
        } else {
            cur += row[k];
        }
    }
    cells.push(cur.trim());
    return cells;
};

const normalizeAlign = (cell: string): TableAlign => {
    const match = /^(:?)(-+)(:?)$/.exec(cell);
    if (!match) {
        return 'none';
    }
    if (match[1] && match[3]) {
        return 'center';
    }
    if (match[3]) {
        return 'right';
    }
    if (match[1]) {
        return 'left';
    }
    return 'none';
};

/** 表格骨架：剥离全部格式信息（横线数、padding）后的内容与对齐语义 */
const tableSkeleton = (lines: string[]): TableSkeleton => {
    const header = splitRowCells(lines[0]);
    const aligns = splitRowCells(lines[1]).map(normalizeAlign);
    const rows = lines.slice(2).map(splitRowCells);
    return { header, aligns, rows };
};

const sameSkeleton = (a: string[], b: string[]): boolean =>
    JSON.stringify(tableSkeleton(a)) === JSON.stringify(tableSkeleton(b));

/** 块匹配谓词：text 字节相等；table 骨架相等（用于前后缀锚定与中段裁决） */
const blocksMatch = (a: Block, b: Block): boolean => {
    if (a.kind !== b.kind) {
        return false;
    }
    if (a.kind === 'text') {
        return a.lines.join('\n') === (b as TextBlock).lines.join('\n');
    }
    return sameSkeleton(a.lines, (b as TableBlock).lines);
};

/** 块的输出行（表格块含前导空行） */
const blockLines = (block: Block): string[] =>
    block.kind === 'table'
        ? [...block.leadingBlanks, ...block.lines]
        : block.lines;

/**
 * 主入口：以 oldText 为格式基准改写 newText。
 * 幂等且确定（同输入同输出）；任何内部异常回退为返回（LF 归一化的）newText。
 */
export const preserveTableFormat = (oldText: string, newText: string): string => {
    const oldLf = oldText.replace(/\r/g, '');
    const newLf = newText.replace(/\r/g, '');
    try {
        const oldBlocks = splitBlocks(oldLf);
        const newBlocks = splitBlocks(newLf);

        // 前缀锚定：块匹配（text 字节等 / table 骨架等）即可锚定
        let start = 0;
        while (start < oldBlocks.length && start < newBlocks.length
            && blocksMatch(oldBlocks[start], newBlocks[start])) {
            start++;
        }
        // 后缀锚定：不与前缀区重叠
        let oldEnd = oldBlocks.length;
        let newEnd = newBlocks.length;
        while (oldEnd > start && newEnd > start
            && blocksMatch(oldBlocks[oldEnd - 1], newBlocks[newEnd - 1])) {
            oldEnd--;
            newEnd--;
        }

        // 锚定区表格输出 old 原文（骨架等但格式可能被 Lute 重排，还原）
        const out: string[] = [];
        for (let k = 0; k < start; k++) {
            out.push(...blockLines(oldBlocks[k]));
        }

        // 中段：块数与 kind 序列一致时逐块裁决，否则整段保守采用新内容
        const oldMid = oldBlocks.slice(start, oldEnd);
        const newMid = newBlocks.slice(start, newEnd);
        if (oldMid.length === newMid.length
            && oldMid.every((block, k) => block.kind === newMid[k].kind)) {
            for (let k = 0; k < newMid.length; k++) {
                if (newMid[k].kind === 'text') {
                    out.push(...newMid[k].lines);
                } else if (oldMid[k].kind === 'table' && sameSkeleton(oldMid[k].lines, newMid[k].lines)) {
                    out.push(...blockLines(oldMid[k]));
                } else {
                    out.push(...blockLines(newMid[k]));
                }
            }
        } else {
            for (const block of newMid) {
                out.push(...blockLines(block));
            }
        }

        for (let k = oldEnd; k < oldBlocks.length; k++) {
            out.push(...blockLines(oldBlocks[k]));
        }

        return out.join('\n');
    } catch {
        return newLf;
    }
};
