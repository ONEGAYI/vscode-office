const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

const code = buildSync({
    entryPoints: [resolve(__dirname, '../../src/service/markdown/imageSignature.ts')],
    platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const moduleRef = { exports: {} };
runInNewContext(code, { module: moduleRef, exports: moduleRef.exports });
const detect = moduleRef.exports.detectClipboardImageExtension;

test('clipboard image signatures map to their saved extensions', () => {
    const cases = [
        ['89504e470d0a1a0a', 'png'],
        ['ffd8ffe00010', 'jpg'],
        [Buffer.from('GIF89a').toString('hex'), 'gif'],
        [Buffer.from('RIFFxxxxWEBP').toString('hex'), 'webp'],
        ['424d00000000', 'bmp'],
        ['49492a0000000000', 'tif'],
        ['0000010001000000', 'ico'],
        [Buffer.from('\0\0\0\x18ftypavif').toString('hex'), 'avif'],
        [Buffer.from('\0\0\0\x18ftyphevc').toString('hex'), 'heic'],
    ];
    for (const [hex, expected] of cases) {
        assert.equal(detect(Buffer.from(hex, 'hex')), expected, hex);
    }
    assert.equal(detect(Buffer.from('unknown')), undefined);
});
