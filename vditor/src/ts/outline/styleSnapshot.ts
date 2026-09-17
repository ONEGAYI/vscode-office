/**
 * 大纲条目标式快照的纯逻辑（无 DOM 依赖）。
 *
 * 偏差式透传：标题被 CSS 控制时，仅注入与「编辑器根计算值」不同的属性；基础
 * 排版不透传，避免逐行内联样式杀死大纲 hover/active 变色。
 * font-size 一律排除——大纲保留自身按层级递减的字号体系。
 * font-weight 一律排除——标题层级字重（如 _reset.less 对 h1-h6 的 600）不进
 * 大纲；行内真实加粗由 strong/b 标签直通（克隆 innerHTML）+ UA 默认样式呈现。
 */
export interface IComputedStyleSource {
    /** CSS 属性名（kebab-case）→ 计算值，取自 getComputedStyle().getPropertyValue() */
    [property: string]: string;
}

/** 与编辑器根比较偏差后透传的属性（按输出顺序排列） */
const DEVIATION_PROPS = [
    "color",
    "background-color",
    "font-family",
    "font-style",
    "text-decoration-line",
    "text-decoration-style",
    "text-decoration-color",
];

const isTransparent = (value: string): boolean => {
    return value === "transparent" || value === "rgba(0, 0, 0, 0)";
};

/**
 * 生成注入大纲条目内容 span 的 inline style 字符串；无偏差时返回空字符串。
 *
 * @param heading 标题元素的计算样式（属性集子集）
 * @param base 编辑器根元素的计算样式（同一属性集）
 */
export const buildOutlineStyleSnapshot = (heading: IComputedStyleSource, base: IComputedStyleSource): string => {
    const declarations: string[] = [];
    DEVIATION_PROPS.forEach((prop) => {
        const headingValue = (heading[prop] || "").trim();
        if (!headingValue) {
            return;
        }
        if (prop === "background-color" && isTransparent(headingValue)) {
            return;
        }
        if (prop === "font-style") {
            if (headingValue === "normal") {
                return;
            }
        } else {
            const baseValue = (base[prop] || "").trim();
            // 基线值缺失（jsdom 等）时无法判定偏差，保守跳过
            if (!baseValue || headingValue === baseValue) {
                return;
            }
        }
        declarations.push(`${prop}: ${headingValue}`);
    });
    return declarations.length === 0 ? "" : `${declarations.join("; ")};`;
};

/** 快照需要采集的 CSS 属性集（供 DOM 侧 getComputedStyle 取值） */
export const OUTLINE_SNAPSHOT_PROPS = DEVIATION_PROPS;

/** 从 CSSStyleDeclaration 采集属性集的计算值（DOM 侧薄适配） */
export const collectComputedStyleSource = (computed: CSSStyleDeclaration): IComputedStyleSource => {
    const source: IComputedStyleSource = {};
    OUTLINE_SNAPSHOT_PROPS.forEach((prop) => {
        source[prop] = computed.getPropertyValue(prop);
    });
    return source;
};
