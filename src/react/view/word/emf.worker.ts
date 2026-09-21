import { FromEMF } from './vendor/FromEMF.js';
import { ToContext2D } from './vendor/ToContext2D.js';
import { validateEmf } from './emfValidation';

// The writer only needs canvas construction; no DOM or network access is used.
Object.assign(globalThis, { document: { createElement: () => new OffscreenCanvas(1, 1) } });
self.onmessage = async ({ data }: MessageEvent<ArrayBuffer>) => {
    try {
        const { width, height } = validateEmf(data);
        const writer = new ToContext2D(0, 1);
        writer.StartPage = function (x0: number, y0: number) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.ctx.setTransform(1, 0, 0, 1, -x0, -y0);
        };
        FromEMF.Parse(data, writer);
        const png = await writer.canvas.convertToBlob({ type: 'image/png' });
        self.postMessage({ png });
    } catch (error) {
        self.postMessage({ error: String(error) });
    }
};
