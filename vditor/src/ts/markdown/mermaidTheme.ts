export interface IEditorAccentColors {
    red: string;
    blue: string;
    yellow: string;
    orange: string;
    green: string;
    purple: string;
    foreground: string;
}

interface IMermaidThemePalette {
    background: string;
    panel: string;
    foreground: string;
    muted: string;
    border: string;
    accent: string;
    secondary: string;
    tertiary: string;
    note: string;
    warning: string;
    error: string;
    darkMode?: boolean;
}

const CUSTOM_MERMAID_THEMES: Record<string, IMermaidThemePalette> = {
    Ocean: {
        background: "#f3fbff",
        panel: "#ffffff",
        foreground: "#183042",
        muted: "#5c7485",
        border: "#9bc9dc",
        accent: "#147fb5",
        secondary: "#53c2c5",
        tertiary: "#8ea7ff",
        note: "#d9f3ff",
        warning: "#f2b84b",
        error: "#d25b6a",
    },
    Sunset: {
        background: "#fff8f0",
        panel: "#ffffff",
        foreground: "#3d261f",
        muted: "#8a6556",
        border: "#e3b69b",
        accent: "#d96c2c",
        secondary: "#f0a03f",
        tertiary: "#c46fa1",
        note: "#ffe4bd",
        warning: "#d99b25",
        error: "#c24645",
    },
    Dracula: {
        background: "#282a36",
        panel: "#343746",
        foreground: "#f8f8f2",
        muted: "#bdc1d6",
        border: "#6272a4",
        accent: "#bd93f9",
        secondary: "#8be9fd",
        tertiary: "#ff79c6",
        note: "#44475a",
        warning: "#f1fa8c",
        error: "#ff5555",
        darkMode: true,
    },
    Monokai: {
        background: "#272822",
        panel: "#35362f",
        foreground: "#f8f8f2",
        muted: "#cfcfc2",
        border: "#75715e",
        accent: "#a6e22e",
        secondary: "#66d9ef",
        tertiary: "#ae81ff",
        note: "#49483e",
        warning: "#e6db74",
        error: "#f92672",
        darkMode: true,
    },
    Nord: {
        background: "#2e3440",
        panel: "#3b4252",
        foreground: "#eceff4",
        muted: "#d8dee9",
        border: "#4c566a",
        accent: "#88c0d0",
        secondary: "#8fbcbb",
        tertiary: "#b48ead",
        note: "#434c5e",
        warning: "#ebcb8b",
        error: "#bf616a",
        darkMode: true,
    },
};

const readCssVar = (root: HTMLElement, name: string, fallback = ""): string => {
    const value = getComputedStyle(root).getPropertyValue(name).trim();
    return value || fallback;
};

const parseRgb = (color: string): [number, number, number] | null => {
    const value = color.trim();
    if (!value) {
        return null;
    }
    if (value.startsWith("#")) {
        const hex = value.slice(1);
        if (hex.length === 3) {
            return [
                parseInt(hex[0] + hex[0], 16),
                parseInt(hex[1] + hex[1], 16),
                parseInt(hex[2] + hex[2], 16),
            ];
        }
        if (hex.length >= 6) {
            return [
                parseInt(hex.slice(0, 2), 16),
                parseInt(hex.slice(2, 4), 16),
                parseInt(hex.slice(4, 6), 16),
            ];
        }
    }
    const rgbMatch = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (rgbMatch) {
        return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
    }
    return null;
};

export const isDarkBackground = (color: string): boolean => {
    const rgb = parseRgb(color);
    if (!rgb) {
        return false;
    }
    const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return luminance < 0.5;
};

interface RgbaColor {
    r: number;
    g: number;
    b: number;
    a: number;
}

const parseRgba = (color: string): RgbaColor | null => {
    const value = color.trim();
    if (!value) {
        return null;
    }
    if (value.startsWith("#")) {
        const hex = value.slice(1);
        if (hex.length === 3) {
            return {
                r: parseInt(hex[0] + hex[0], 16),
                g: parseInt(hex[1] + hex[1], 16),
                b: parseInt(hex[2] + hex[2], 16),
                a: 1,
            };
        }
        if (hex.length >= 6) {
            const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
            return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16),
                a,
            };
        }
        return null;
    }
    const rgbMatch = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)/i);
    if (rgbMatch) {
        let a = 1;
        if (rgbMatch[4] !== undefined) {
            a = rgbMatch[4].endsWith("%") ? Number(rgbMatch[4].slice(0, -1)) / 100 : Number(rgbMatch[4]);
        }
        return { r: Number(rgbMatch[1]), g: Number(rgbMatch[2]), b: Number(rgbMatch[3]), a };
    }
    return null;
};

const relativeLuminance = (r: number, g: number, b: number): number => {
    const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (a: RgbaColor, b: RgbaColor): number => {
    const l1 = relativeLuminance(a.r, a.g, a.b);
    const l2 = relativeLuminance(b.r, b.g, b.b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const toRgbString = (c: RgbaColor): string =>
    `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

/**
 * 半透明/低对比连线色的实色化：themeVariables 会把 lineColor 固化进 SVG 渲染结果，
 * vditor 的 --second-color 等来源常带低 alpha，直接直通会在浅色底或弹窗毛玻璃背衬上
 * 对比度不足。先把 alpha 合成到背景得到实色，再按需向前景色混合至 WCAG 对比度达标。
 */
export const ensureContrastColor = (color: string, bg: string, fg: string, minContrast = 3): string => {
    const fgRgb = parseRgba(fg);
    const bgRgb = parseRgba(bg);
    if (!fgRgb || !bgRgb) {
        return color;
    }
    const source = parseRgba(color);
    if (!source) {
        return color;
    }
    const composite: RgbaColor = {
        r: source.r * source.a + bgRgb.r * (1 - source.a),
        g: source.g * source.a + bgRgb.g * (1 - source.a),
        b: source.b * source.a + bgRgb.b * (1 - source.a),
        a: 1,
    };
    if (source.a >= 1 && contrastRatio(source, bgRgb) >= minContrast) {
        // 已达标的不透明色原样保留，不重写调色板字面量
        return color;
    }
    for (let t = 0.1; t < 1; t += 0.1) {
        const mixed: RgbaColor = {
            r: composite.r + (fgRgb.r - composite.r) * t,
            g: composite.g + (fgRgb.g - composite.g) * t,
            b: composite.b + (fgRgb.b - composite.b) * t,
            a: 1,
        };
        if (contrastRatio(mixed, bgRgb) >= minContrast) {
            return toRgbString(mixed);
        }
    }
    return toRgbString(fgRgb);
};

export const findVditorRoot = (element: HTMLElement): HTMLElement => {
    const vditor = element.closest("#vditor") as HTMLElement | null;
    return vditor ?? element;
};

export const readEditorAccentColors = (root: HTMLElement): IEditorAccentColors => ({
    red: readCssVar(root, "--chart-red", "#e51400"),
    blue: readCssVar(root, "--chart-blue", "#3794ff"),
    yellow: readCssVar(root, "--chart-yellow", "#cca700"),
    orange: readCssVar(root, "--chart-orange", "#d18616"),
    green: readCssVar(root, "--chart-green", "#89d185"),
    purple: readCssVar(root, "--chart-purple", "#b180d7"),
    foreground: readCssVar(root, "--chart-foreground", readCssVar(root, "--front-color", "#333333")),
});

export const buildMermaidInitConfig = (themeId: string, root: HTMLElement) => {
    if (themeId === "Light") {
        return { theme: "default" };
    }
    if (themeId === "Dark") {
        return { theme: "dark" };
    }
    if (themeId === "Forest") {
        return { theme: "forest" };
    }
    const customTheme = CUSTOM_MERMAID_THEMES[themeId];
    if (customTheme) {
        return buildCustomMermaidThemeConfig(customTheme);
    }
    return buildMermaidThemeConfig(root);
};

const buildCustomMermaidThemeConfig = (palette: IMermaidThemePalette) => {
    const contrastColor = (bg: string): string => isDarkBackground(bg) ? "#ffffff" : "#1f2020";
    const dark = palette.darkMode ?? isDarkBackground(palette.background);
    const noteText = contrastColor(palette.note);

    return {
        theme: "base",
        themeVariables: {
            activationBkgColor: palette.accent,
            activationBorderColor: palette.accent,
            activeTaskBkgColor: palette.accent,
            activeTaskBorderColor: palette.accent,
            actorBkg: palette.panel,
            actorBorder: palette.accent,
            actorLineColor: palette.muted,
            actorTextColor: palette.foreground,
            altBackground: palette.note,
            altSectionBkgColor: palette.warning,
            arrowheadColor: palette.muted,
            background: palette.background,
            border1: palette.accent,
            border2: palette.border,
            classText: palette.foreground,
            clusterBkg: palette.tertiary,
            clusterTextColor: contrastColor(palette.tertiary),
            clusterBorder: palette.accent,
            critBkgColor: palette.error,
            critBorderColor: palette.error,
            darkMode: dark,
            defaultLinkColor: palette.accent,
            doneTaskBkgColor: palette.muted,
            doneTaskBorderColor: palette.border,
            edgeLabelBackground: palette.background,
            errorBkgColor: palette.error,
            errorTextColor: contrastColor(palette.error),
            fillType0: palette.panel,
            fillType1: palette.accent,
            fillType2: palette.tertiary,
            fillType3: palette.secondary,
            fillType4: palette.note,
            fillType5: palette.warning,
            fillType6: palette.error,
            fillType7: palette.tertiary,
            fontFamily: "sans-serif",
            fontSize: "16px",
            gridColor: palette.border,
            labelBackground: palette.background,
            labelBoxBkgColor: palette.panel,
            labelBoxBorderColor: palette.accent,
            labelColor: palette.foreground,
            labelTextColor: palette.foreground,
            lineColor: palette.muted,
            loopTextColor: palette.warning,
            mainBkg: palette.panel,
            mainContrastColor: palette.foreground,
            nodeBkg: palette.panel,
            nodeBorder: palette.accent,
            noteBkgColor: palette.note,
            noteBorderColor: palette.warning,
            noteTextColor: noteText,
            primaryBorderColor: palette.accent,
            primaryColor: palette.panel,
            primaryTextColor: palette.foreground,
            secondBkg: palette.secondary,
            secondaryBorderColor: palette.accent,
            secondaryColor: palette.accent,
            secondaryTextColor: contrastColor(palette.accent),
            sectionBkgColor: palette.note,
            sectionBkgColor2: palette.warning,
            sequenceNumberColor: contrastColor(palette.accent),
            signalColor: palette.accent,
            signalTextColor: palette.foreground,
            taskBkgColor: palette.secondary,
            taskBorderColor: palette.accent,
            taskTextClickableColor: palette.accent,
            taskTextColor: contrastColor(palette.secondary),
            taskTextDarkColor: "#1f2020",
            taskTextLightColor: "#ffffff",
            taskTextOutsideColor: palette.foreground,
            tertiaryBorderColor: palette.tertiary,
            tertiaryColor: palette.tertiary,
            tertiaryTextColor: contrastColor(palette.tertiary),
            textColor: palette.foreground,
            titleColor: palette.accent,
            todayLineColor: palette.error,
        },
    };
};

export const buildMermaidThemeConfig = (root: HTMLElement) => {
    const editorBg = readCssVar(root, "--bg-color");
    const dark = root.classList.contains("vditor--dark") || isDarkBackground(editorBg);
    const bg = readCssVar(root, "--toolbar-background-color", readCssVar(root, "--second-bg-color", editorBg));
    const panelBg = readCssVar(root, "--second-bg-color", readCssVar(root, "--code-bg-color", bg));
    const fg = readCssVar(root, "--front-color", dark ? "#d4d4d4" : "#333333");
    const codeBg = readCssVar(root, "--code-bg-color", panelBg);
    const tableHeader = readCssVar(root, "--table-header-bg", codeBg);
    const border = readCssVar(root, "--border-color", dark ? "#444444" : "#d0d0d0");
    const accent = readCssVar(root, "--list-hover-color") || readCssVar(root, "--link-color", readCssVar(root, "--chart-blue"));
    const muted = readCssVar(root, "--second-color", border);
    // --second-color 常是半透明浅灰（如 rgba(88,96,105,.36)），会被固化进 SVG 笔画，
    // 在浅底与弹窗毛玻璃背衬上低于图形 3:1 对比底线，连线/箭头必须实色化
    const lineSolid = ensureContrastColor(muted, bg, fg);
    const error = readCssVar(root, "--error-color", readCssVar(root, "--chart-red", "#e51400"));
    const chart = readEditorAccentColors(root);
    const noteBg = chart.yellow;
    const noteFg = isDarkBackground(noteBg) ? fg : "#1f2020";
    const contrastColor = (bg: string): string => isDarkBackground(bg) ? "#ffffff" : "#1f2020";

    return {
        theme: "base",
        themeVariables: {
            activationBkgColor: chart.blue,
            activationBorderColor: accent,
            activeTaskBkgColor: chart.blue,
            activeTaskBorderColor: accent,
            actorBkg: panelBg,
            actorBorder: accent,
            actorLineColor: muted,
            actorTextColor: fg,
            altBackground: codeBg,
            altSectionBkgColor: chart.orange,
            arrowheadColor: lineSolid,
            background: bg,
            border1: accent,
            border2: border,
            classText: fg,
            clusterBkg: chart.purple,
            clusterTextColor: contrastColor(chart.purple),
            clusterBorder: accent,
            critBkgColor: error,
            critBorderColor: error,
            darkMode: dark,
            defaultLinkColor: accent,
            doneTaskBkgColor: muted,
            doneTaskBorderColor: border,
            edgeLabelBackground: bg,
            errorBkgColor: error,
            errorTextColor: contrastColor(error),
            fillType0: panelBg,
            fillType1: chart.blue,
            fillType2: chart.purple,
            fillType3: chart.green,
            fillType4: chart.yellow,
            fillType5: chart.orange,
            fillType6: chart.red,
            fillType7: chart.purple,
            fontFamily: "sans-serif",
            fontSize: "16px",
            gridColor: border,
            labelBackground: bg,
            labelBoxBkgColor: panelBg,
            labelBoxBorderColor: accent,
            labelColor: fg,
            labelTextColor: fg,
            lineColor: lineSolid,
            loopTextColor: chart.orange,
            mainBkg: panelBg,
            mainContrastColor: fg,
            nodeBkg: panelBg,
            nodeBorder: accent,
            noteBkgColor: noteBg,
            noteBorderColor: chart.orange,
            noteTextColor: noteFg,
            primaryBorderColor: accent,
            primaryColor: panelBg,
            primaryTextColor: fg,
            secondBkg: chart.green,
            secondaryBorderColor: chart.blue,
            secondaryColor: chart.blue,
            secondaryTextColor: contrastColor(chart.blue),
            sectionBkgColor: chart.yellow,
            sectionBkgColor2: chart.orange,
            sequenceNumberColor: contrastColor(chart.blue),
            signalColor: chart.blue,
            signalTextColor: fg,
            taskBkgColor: chart.green,
            taskBorderColor: accent,
            taskTextClickableColor: accent,
            taskTextColor: contrastColor(chart.green),
            taskTextDarkColor: "#1f2020",
            taskTextLightColor: "#ffffff",
            taskTextOutsideColor: fg,
            tertiaryBorderColor: chart.purple,
            tertiaryColor: chart.purple,
            tertiaryTextColor: contrastColor(chart.purple),
            textColor: fg,
            titleColor: chart.blue,
            todayLineColor: error,
        },
    };
};
