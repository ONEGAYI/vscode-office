const { parentPort, workerData } = require('node:worker_threads');

(async () => {
    try {
        const htmlToDocx = require(workerData.converterPath);
        const result = await htmlToDocx(workerData.html, '', {}, '');
        const bytes = await result.arrayBuffer();
        parentPort.postMessage({ bytes }, [bytes]);
    } catch (error) {
        parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
})();
