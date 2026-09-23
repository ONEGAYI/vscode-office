const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInNewContext } = require('node:vm');

const imageCode = buildSync({
    entryPoints: [path.resolve(__dirname, '../../src/service/markdown/imageSignature.ts')],
    platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const imageModule = { exports: {} };
runInNewContext(imageCode, { module: imageModule, exports: imageModule.exports });

const serviceCode = buildSync({
    entryPoints: [path.resolve(__dirname, '../../src/service/markdownService.ts')],
    platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const serviceModule = { exports: {} };
runInNewContext(serviceCode, {
    module: serviceModule, exports: serviceModule.exports,
    require: name => ({
        fs, path,
        './markdown/imageSignature': imageModule.exports,
    })[name] ?? {},
    Buffer,
});

test('clipboard image save renames JPEG by signature and preserves unknown extensions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-image-guide-'));
    const original = path.join(dir, 'photo.png');
    const renamed = path.join(dir, 'photo.jpg');
    const unknown = path.join(dir, 'unknown.webp');
    try {
        fs.writeFileSync(original, Buffer.from('ffd8ffe00010', 'hex'));
        const relative = await serviceModule.exports.MarkdownService.imgExtGuide(original, 'images/photo.png');
        assert.equal(relative, 'images/photo.jpg');
        assert.equal(fs.existsSync(renamed), true);
        assert.equal(fs.existsSync(original), false);

        fs.writeFileSync(unknown, Buffer.from('unknown'));
        assert.equal(await serviceModule.exports.MarkdownService.imgExtGuide(unknown, 'images/unknown.webp'),
            'images/unknown.webp');
        assert.equal(fs.existsSync(unknown), true);
    } finally {
        if (fs.existsSync(original)) fs.unlinkSync(original);
        if (fs.existsSync(renamed)) fs.unlinkSync(renamed);
        if (fs.existsSync(unknown)) fs.unlinkSync(unknown);
        fs.rmdirSync(dir);
    }
});
