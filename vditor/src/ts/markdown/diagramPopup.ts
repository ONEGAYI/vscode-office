import { codicon } from "../util/codicon";
import { isDarkPreview } from "../preview/image";

/**
 * 图表弹窗预览：mermaid / plantuml 渲染块右上角 popup 按钮的放大查看层。
 *
 * - 内容为当前渲染结果的克隆（svg / img），不参与编辑器 DOM 与撤销栈
 * - 滚轮以光标为锚缩放，+/-/0 与方向键经键盘操作，拖拽平移
 * - 下载经 options.onDiagramDownload 回调交由宿主落盘（未配置则隐藏按钮）
 */

export type DiagramPopupKind = "mermaid" | "plantuml";

export interface IDiagramPopupSource {
    vditor?: IVditor;
    /** .vditor-mermaid-host 或 .vditor-plantuml-figure */
    host: HTMLElement;
    kind: DiagramPopupKind;
}

const OVERLAY_CLASS = "vditor-diagram-overlay";
const STAGE_CLASS = "vditor-diagram-overlay__stage";
const CONTENT_CLASS = "vditor-diagram-overlay__content";
const DRAGGING_CLASS = "vditor-diagram-overlay__stage--dragging";

const MIN_SCALE = 0.05;
const MAX_SCALE = 40;
const ZOOM_STEP = 1.2;
const PAN_STEP = 40;
/** 初始 contain-fit 留白与放大上限（小图不盲目撑满视口） */
const FIT_MARGIN = 0.92;
const FIT_UPSCALE_MAX = 2;
const CLOSE_ANIMATION_MS = 220;

const FALLBACK_MERMAID_SIZE = { w: 960, h: 540 };
const FALLBACK_PLANTUML_SIZE = { w: 800, h: 600 };

let activeOverlay: HTMLElement | null = null;
let activeKeyDownHandler: ((event: KeyboardEvent) => void) | null = null;
let restoreFocusTarget: HTMLElement | null = null;

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

const parsePxLength = (value: string | null): number => {
    if (!value) {
        return 0;
    }
    const v = value.trim();
    if (v.endsWith("px")) {
        return Number.parseFloat(v) || 0;
    }
    if (/^\d+(\.\d+)?$/.test(v)) {
        return Number.parseFloat(v);
    }
    return 0;
};

const readSvgIntrinsicSize = (svg: SVGSVGElement) => {
    const viewBox = svg.getAttribute("viewBox");
    if (viewBox) {
        const parts = viewBox.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
            return { w: parts[2], h: parts[3] };
        }
    }
    const w = parsePxLength(svg.getAttribute("width"));
    const h = parsePxLength(svg.getAttribute("height"));
    if (w > 0 && h > 0) {
        return { w, h };
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        return { w: rect.width, h: rect.height };
    }
    return null;
};

const readImgIntrinsicSize = (img: HTMLImageElement) => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        return { w: img.naturalWidth, h: img.naturalHeight };
    }
    const w = parsePxLength(img.getAttribute("width"));
    const h = parsePxLength(img.getAttribute("height"));
    if (w > 0 && h > 0) {
        return { w, h };
    }
    return null;
};

/** 导出用：把编辑器里的 svg 规整为尺寸自含的独立文档 */
const serializeMermaidSvg = (svg: SVGSVGElement): string | null => {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    // 根 id 必须保留：mermaid 的内嵌 <style> 规则全部以 `#<renderId>` 前缀，去掉 id 会让主题样式整体失配
    for (const prop of ["max-width", "width", "height"]) {
        clone.style.removeProperty(prop);
    }
    const size = readSvgIntrinsicSize(svg);
    if (size) {
        clone.setAttribute("width", String(Math.round(size.w)));
        clone.setAttribute("height", String(Math.round(size.h)));
    }
    if (!clone.getAttribute("xmlns")) {
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
};

export const closeDiagramPopup = () => {
    if (!activeOverlay) {
        return;
    }
    const overlay = activeOverlay;
    activeOverlay = null;
    if (activeKeyDownHandler) {
        document.removeEventListener("keydown", activeKeyDownHandler);
        activeKeyDownHandler = null;
    }
    if (restoreFocusTarget && document.body.contains(restoreFocusTarget)) {
        restoreFocusTarget.focus();
    }
    restoreFocusTarget = null;
    overlay.dispatchEvent(new Event("vditor-diagram-popup-close"));
    overlay.classList.add(`${OVERLAY_CLASS}--closing`);
    window.setTimeout(() => {
        overlay.remove();
    }, CLOSE_ANIMATION_MS);
    if (!document.querySelector(`.${OVERLAY_CLASS}:not(.${OVERLAY_CLASS}--closing)`)) {
        document.body.style.overflow = "";
    }
};

export const openDiagramPopup = (source: IDiagramPopupSource) => {
    const { vditor, host, kind } = source;

    let contentClone: HTMLElement | null = null;
    let intrinsicSize: { w: number; h: number } | null = null;

    if (kind === "mermaid") {
        const svg = host.querySelector("svg");
        if (!svg) {
            // 未渲染完成的块直接放弃：先关旧弹窗再守卫会让点击"既无反应又关掉了当前弹窗"
            return;
        }
        const mermaidElement = svg.closest(".language-mermaid") as HTMLElement | null;
        contentClone = (mermaidElement ?? svg).cloneNode(true) as HTMLElement;
        contentClone.classList.add(CONTENT_CLASS);
        // 复用 host 的 mermaid 主题变量（--mermaid-bg 等）作用域
        contentClone.classList.add("vditor-mermaid-host");
        const theme = host.getAttribute("data-mermaid-theme");
        if (theme) {
            contentClone.setAttribute("data-mermaid-theme", theme);
        }
        contentClone.removeAttribute("id");
        intrinsicSize = readSvgIntrinsicSize(svg) ?? FALLBACK_MERMAID_SIZE;
    } else {
        const img = host.querySelector("img");
        if (!img) {
            return;
        }
        const imgClone = img.cloneNode(true) as HTMLImageElement;
        imgClone.removeAttribute("id");
        contentClone = document.createElement("div");
        contentClone.className = CONTENT_CLASS;
        contentClone.appendChild(imgClone);
        intrinsicSize = readImgIntrinsicSize(img) ?? FALLBACK_PLANTUML_SIZE;
    }

    const i18n = window.VditorI18n;
    closeDiagramPopup();
    const overlay = document.createElement("div");
    overlay.className = `${OVERLAY_CLASS}${isDarkPreview() ? ` ${OVERLAY_CLASS}--dark` : ""}`;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", i18n.diagramPopup ?? "Diagram popup");

    const backdrop = document.createElement("div");
    backdrop.className = `${OVERLAY_CLASS}__backdrop`;

    const stage = document.createElement("div");
    stage.className = STAGE_CLASS;
    // 接管键盘焦点：CodeMirror 的按键命令在自身 DOM 的 keydown 里直接执行，
    // document 冒泡阶段的 preventDefault 拦不住方向键同时驱动弹窗与编辑器
    stage.tabIndex = -1;

    const chrome = document.createElement("div");
    chrome.className = `${OVERLAY_CLASS}__chrome`;

    const toolbar = document.createElement("div");
    toolbar.className = `${OVERLAY_CLASS}__toolbar`;

    const createButton = (action: string, label: string, icon: string) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `${OVERLAY_CLASS}__btn`;
        btn.dataset.action = action;
        btn.setAttribute("aria-label", label);
        btn.innerHTML = icon;
        return btn;
    };

    const zoomOutBtn = createButton("zoom-out", i18n.zoomOut ?? "Zoom out", codicon("zoom-out"));
    const zoomInBtn = createButton("zoom-in", i18n.zoomIn ?? "Zoom in", codicon("zoom-in"));
    const resetBtn = createButton("reset", i18n.resetZoom ?? "Reset zoom", codicon("refresh"));
    const closeBtn = createButton("close", i18n.close ?? "Close", codicon("close"));

    const zoomLabel = document.createElement("span");
    zoomLabel.className = `${OVERLAY_CLASS}__zoom-label`;
    zoomLabel.textContent = "100%";

    toolbar.append(zoomOutBtn, zoomInBtn, zoomLabel, resetBtn, closeBtn);

    const onDiagramDownload = vditor?.options.onDiagramDownload;
    let downloadBtn: HTMLButtonElement | null = null;
    if (typeof onDiagramDownload === "function") {
        downloadBtn = createButton("download", i18n.download ?? "Download", codicon("download"));
        toolbar.insertBefore(downloadBtn, closeBtn);
    }

    chrome.appendChild(toolbar);
    stage.appendChild(contentClone);
    overlay.append(backdrop, stage, chrome);

    let scale = 1;
    let panX = 0;
    let panY = 0;

    const applyTransform = () => {
        contentClone!.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
        zoomLabel.textContent = `${Math.max(1, Math.round(scale * 100))}%`;
    };

    /** 初始 contain-fit：整图可见；小图最多放大到 FIT_UPSCALE_MAX */
    const computeFitScale = () => {
        const rect = stage.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return 1;
        }
        return clampScale(Math.min(
            (rect.width * FIT_MARGIN) / intrinsicSize!.w,
            (rect.height * FIT_MARGIN) / intrinsicSize!.h,
            FIT_UPSCALE_MAX,
        ));
    };

    const resetView = () => {
        scale = computeFitScale();
        panX = 0;
        panY = 0;
        applyTransform();
    };

    const zoomAt = (clientX: number, clientY: number, factor: number) => {
        const rect = stage.getBoundingClientRect();
        const originX = clientX - rect.left - rect.width / 2;
        const originY = clientY - rect.top - rect.height / 2;
        const next = clampScale(scale * factor);
        const ratio = next / scale;
        panX = originX - (originX - panX) * ratio;
        panY = originY - (originY - panY) * ratio;
        scale = next;
        applyTransform();
    };

    const zoomAroundCenter = (factor: number) => {
        const rect = stage.getBoundingClientRect();
        zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
    };

    const panBy = (dx: number, dy: number) => {
        panX += dx;
        panY += dy;
        applyTransform();
    };

    const requestDownload = () => {
        if (typeof onDiagramDownload !== "function") {
            return;
        }
        if (kind === "mermaid") {
            const svg = host.querySelector("svg");
            const serialized = svg ? serializeMermaidSvg(svg as SVGSVGElement) : null;
            if (!serialized) {
                return;
            }
            onDiagramDownload({ kind, fileName: "mermaid-diagram.svg", svg: serialized });
            return;
        }
        const url = host.querySelector("img")?.getAttribute("src");
        if (!url) {
            return;
        }
        onDiagramDownload({ kind, fileName: "plantuml-diagram.svg", url });
    };

    toolbar.addEventListener("click", (event) => {
        const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
        if (!btn) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        switch (btn.dataset.action) {
            case "zoom-in":
                zoomAroundCenter(ZOOM_STEP);
                break;
            case "zoom-out":
                zoomAroundCenter(1 / ZOOM_STEP);
                break;
            case "reset":
                resetView();
                break;
            case "download":
                requestDownload();
                break;
            case "close":
                closeDiagramPopup();
                break;
        }
    });

    overlay.addEventListener("wheel", (event) => {
        event.preventDefault();
        const wheel = event as WheelEvent;
        zoomAt(wheel.clientX, wheel.clientY, wheel.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    }, { passive: false });

    let dragging = false;
    let movedSinceDown = false;
    let lastX = 0;
    let lastY = 0;

    stage.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
            return;
        }
        dragging = true;
        movedSinceDown = false;
        lastX = event.clientX;
        lastY = event.clientY;
        stage.classList.add(DRAGGING_CLASS);
        event.preventDefault();
    });
    const onDragMove = (event: MouseEvent) => {
        if (!dragging) {
            return;
        }
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        if (dx !== 0 || dy !== 0) {
            movedSinceDown = true;
        }
        lastX = event.clientX;
        lastY = event.clientY;
        panBy(dx, dy);
    };
    const onDragEnd = () => {
        if (!dragging) {
            return;
        }
        dragging = false;
        stage.classList.remove(DRAGGING_CLASS);
    };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);

    // 空白处单击关闭；拖拽落点不算单击
    stage.addEventListener("click", (event) => {
        if (event.target === stage && !movedSinceDown) {
            closeDiagramPopup();
        }
    });

    const onKeyDown = (event: KeyboardEvent) => {
        switch (event.key) {
            case "Escape":
                event.preventDefault();
                closeDiagramPopup();
                return;
            case "+":
            case "=":
                event.preventDefault();
                zoomAroundCenter(ZOOM_STEP);
                return;
            case "-":
                event.preventDefault();
                zoomAroundCenter(1 / ZOOM_STEP);
                return;
            case "0":
                event.preventDefault();
                resetView();
                return;
            case "ArrowLeft":
                event.preventDefault();
                panBy(-PAN_STEP, 0);
                return;
            case "ArrowRight":
                event.preventDefault();
                panBy(PAN_STEP, 0);
                return;
            case "ArrowUp":
                event.preventDefault();
                panBy(0, -PAN_STEP);
                return;
            case "ArrowDown":
                event.preventDefault();
                panBy(0, PAN_STEP);
                return;
        }
    };
    activeKeyDownHandler = onKeyDown;
    document.addEventListener("keydown", onKeyDown);

    overlay.addEventListener("vditor-diagram-popup-close", () => {
        document.removeEventListener("mousemove", onDragMove);
        document.removeEventListener("mouseup", onDragEnd);
    }, { once: true });

    restoreFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    activeOverlay = overlay;
    stage.focus();

    requestAnimationFrame(() => {
        overlay.classList.add(`${OVERLAY_CLASS}--visible`);
    });

    resetView();
};
