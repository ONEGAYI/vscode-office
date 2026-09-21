import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const publicId = 'virtual:office-emf-worker';
const resolvedId = '\0' + publicId;
const root = fileURLToPath(new URL('../', import.meta.url));

/** Vite's worker&inline only inlines in production. Webviews need it in dev too. */
export function emfWorkerPlugin(): Plugin {
    return {
        name: 'office-inline-emf-worker',
        resolveId(id) { if (id === publicId) return resolvedId; },
        async load(id) {
            if (id !== resolvedId) return;
            const result = await build({
                absWorkingDir: root,
                entryPoints: ['src/react/view/word/emf.worker.ts'],
                bundle: true, write: false, format: 'iife', platform: 'browser',
                target: 'es2020', metafile: true,
            });
            for (const input of Object.keys(result.metafile!.inputs)) this.addWatchFile(resolve(root, input));
            return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
        },
    };
}
