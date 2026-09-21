import workerSource from 'virtual:office-emf-worker';

export function renderEmfPreview(source: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error('Disposed')); return; }
        const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
        let worker: Worker;
        try { worker = new Worker(url); }
        catch (error) { URL.revokeObjectURL(url); reject(error); return; }
        const finish = (error?: Error, value?: string) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            worker.terminate();
            URL.revokeObjectURL(url);
            if (error) reject(error); else resolve(value!);
        };
        const abort = () => finish(new Error('Disposed'));
        signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => finish(new Error('EMF conversion timed out')), 3000);
        worker.onerror = () => finish(new Error('EMF worker failed'));
        worker.onmessage = ({ data }) => {
            if (data.error) { finish(new Error(data.error)); return; }
            const reader = new FileReader();
            reader.onerror = () => finish(new Error('Cannot read preview'));
            reader.onload = () => finish(undefined, reader.result as string);
            reader.readAsDataURL(data.png);
        };
        try {
            const raw = atob(source.slice(source.indexOf(',') + 1));
            const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
            worker.postMessage(bytes.buffer, [bytes.buffer]);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
}
