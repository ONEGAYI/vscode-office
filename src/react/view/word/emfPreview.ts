/** Only the layout painter is patched; never touch ProseMirror or document data. */
export function installEmfPreviews(root: HTMLElement, convert: (source: string, signal: AbortSignal) => Promise<string>) {
    const controller = new AbortController();
    const pending = new WeakMap<HTMLImageElement, string>();
    const cache = new Map<string, Promise<string>>();
    let queue = Promise.resolve();
    const scan = () => {
        if (controller.signal.aborted) return;
        root.querySelectorAll<HTMLImageElement>('.layout-image img, img.layout-run-image, .layout-run-image img').forEach(img => {
            const source = img.getAttribute('src') || '';
            if (img.closest('[contenteditable="true"], .ProseMirror') || !/^data:image\/(?:x-)?emf;base64,/i.test(source) || pending.get(img) === source) return;
            pending.set(img, source);
            let result = cache.get(source);
            if (!result) {
                if (source.length > 3_000_000 || cache.size >= 32) {
                    img.title = 'EMF 预览超过大小或数量限制';
                    return;
                }
                result = queue.then(() => {
                    if (controller.signal.aborted) throw new Error('Disposed');
                    return convert(source, controller.signal);
                });
                cache.set(source, result);
                queue = result.then(() => {}, () => {});
            }
            void result.then(png => {
                if (controller.signal.aborted || !root.contains(img) || img.getAttribute('src') !== source) return;
                img.src = png;
                img.dataset.officeEmfPreview = 'true';
                img.title = 'EMF 静态预览（部分绘图指令可能不支持）';
            }, () => {
                if (!controller.signal.aborted && root.contains(img) && img.getAttribute('src') === source) {
                    img.alt = img.alt || 'EMF 预览不可用';
                    img.title = '无法转换此 EMF 预览；原始对象未修改';
                }
            });
        });
    };
    const observer = new root.ownerDocument.defaultView!.MutationObserver(scan);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    scan();
    return () => { controller.abort(); observer.disconnect(); cache.clear(); };
}
