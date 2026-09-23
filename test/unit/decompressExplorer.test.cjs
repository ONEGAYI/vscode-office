const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

const code = buildSync({
    entryPoints: [resolve(__dirname, '../../src/provider/compress/decompressHandler.ts')],
    platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;

test('macOS Explorer reveal passes a filename as an argument without a shell', () => {
    const events = {};
    const calls = [];
    const moduleRef = { exports: {} };
    const mocks = {
        child_process: {
            exec: (...args) => calls.push(['exec', ...args]),
            execFile: (...args) => calls.push(['execFile', ...args]),
        },
        fs: { existsSync: () => false, rm() {} },
        os: { platform: () => 'darwin', tmpdir: () => '/tmp' },
        path: require('node:path'),
        vscode: { Uri: { file: value => value }, commands: { executeCommand() {} } },
    };
    runInNewContext(code, {
        module: moduleRef, exports: moduleRef.exports, require: name => mocks[name], Date,
    });
    const unsafeName = '/tmp/notes"; touch /tmp/unsafe; "';
    moduleRef.exports.handlerCommonDecompress({ fsPath: unsafeName }, {
        on(name, callback) { events[name] = callback; return this; },
    });
    events.showInExplorer();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'execFile');
    assert.equal(calls[0][1], 'open');
    assert.equal(calls[0][2][0], '-R');
    assert.equal(calls[0][2][1], resolve(unsafeName));
});

test('Windows Explorer reveal also passes the path as an argument', () => {
    const events = {};
    const calls = [];
    const moduleRef = { exports: {} };
    runInNewContext(code, {
        module: moduleRef, exports: moduleRef.exports,
        require: name => ({
            child_process: { execFile: (...args) => calls.push(args) },
            fs: { existsSync: () => false, rm() {} },
            os: { platform: () => 'win32', tmpdir: () => 'C:/Temp' },
            path: require('node:path'),
            vscode: { Uri: { file: value => value }, commands: { executeCommand() {} } },
        })[name],
        Date,
    });
    const file = 'C:/Temp/a & b.zip';
    moduleRef.exports.handlerCommonDecompress({ fsPath: file }, {
        on(name, callback) { events[name] = callback; return this; },
    });
    events.showInExplorer();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'explorer.exe');
    assert.equal(calls[0][1][0], '/select,');
    assert.equal(calls[0][1][1], resolve(file));
});
