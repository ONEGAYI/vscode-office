const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { existsSync } = require('node:fs');

test('malformed DOCX image fails in an isolated worker without exhausting the host', () => {
    const result = spawnSync(process.execPath, [
        resolve(__dirname, '../fixtures/docxMalformedProbe.cjs'),
    ], { timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `status=${result.status} signal=${result.signal} stderr=${result.stderr.slice(-500)}`);
    assert.match(result.stdout, /ISOLATED_ERROR Worker terminated due to reaching memory limit/);
});

test('ordinary PNG still exports a DOCX through the worker', () => {
    const result = spawnSync(process.execPath, [
        resolve(__dirname, '../fixtures/docxMalformedProbe.cjs'), '--normal',
    ], { timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `status=${result.status} stderr=${result.stderr.slice(-500)}`);
    assert.match(result.stdout, /CONVERTED/);
});

test('packaged converter remains isolated for malformed images', {
    skip: !existsSync(resolve(__dirname, '../../out/node_modules/vscode-html-to-docx.js')),
}, () => {
    const result = spawnSync(process.execPath, [
        resolve(__dirname, '../fixtures/docxMalformedProbe.cjs'), '--packaged',
    ], { timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `status=${result.status} stderr=${result.stderr.slice(-500)}`);
    assert.match(result.stdout, /ISOLATED_ERROR Worker terminated due to reaching memory limit/);
});

test('packaged converter still exports a normal PNG', {
    skip: !existsSync(resolve(__dirname, '../../out/node_modules/vscode-html-to-docx.js')),
}, () => {
    const result = spawnSync(process.execPath, [
        resolve(__dirname, '../fixtures/docxMalformedProbe.cjs'), '--packaged', '--normal',
    ], { timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `status=${result.status} stderr=${result.stderr.slice(-500)}`);
    assert.match(result.stdout, /CONVERTED/);
});
