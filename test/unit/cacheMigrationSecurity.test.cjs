const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

const code = buildSync({
    entryPoints: [resolve(__dirname, '../../src/service/autoClearCacheStorage.ts')],
    platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;

test('legacy migration never removes the product-wide WebStorage directory', async () => {
    const removed = [];
    const updates = [];
    const moduleRef = { exports: {} };
    const mocks = {
        vscode: { env: { appName: 'Visual Studio Code' } },
        '@/common/Output': { Output: { debug() {} } },
        '@/common/extensionHost': { isWebExtensionHost: () => false },
        fs: { existsSync: () => true },
        'fs/promises': { rm: async (...args) => removed.push(args) },
        os: { homedir: () => 'C:/Users/test' },
        path: require('node:path'),
    };
    runInNewContext(code, {
        module: moduleRef, exports: moduleRef.exports,
        require: (name) => mocks[name],
        process: { platform: 'win32', env: { APPDATA: 'C:/Users/test/AppData/Roaming' } },
    });
    await moduleRef.exports.autoClearCacheStorage({
        globalState: {
            get: () => undefined,
            update: async (...args) => updates.push(args),
        },
    });
    assert.equal(removed.length, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0][1], true);
});
