// Compile just these tests so the regression suite also runs on CI's Node 20.
const { buildSync } = require('esbuild');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const output = mkdtempSync(join(tmpdir(), 'office-markdown-unit-'));
try {
    const files = ['switchEditorPlanner'];
    const tests = files.map(name => {
        const outfile = join(output, name + '.test.cjs');
        buildSync({
            entryPoints: [resolve(__dirname, 'unit', name + '.test.ts')],
            outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node20',
        });
        return outfile;
    });
    const result = spawnSync(process.execPath, ['--test', ...tests,
        resolve(__dirname, 'unit/markdownTextDiff.test.cjs'),
        resolve(__dirname, 'unit/markdownMenu.test.cjs'),
        resolve(__dirname, 'unit/markdownSwitchCompatibility.test.cjs')], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} finally {
    rmSync(output, { recursive: true, force: true });
}
