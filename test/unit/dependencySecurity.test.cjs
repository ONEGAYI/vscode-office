const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRequire } = require('node:module');

test('EPUB XML parser uses a security-maintained xmldom release', () => {
    const fromEpub = createRequire(require.resolve('epubjs'));
    const version = fromEpub('@xmldom/xmldom/package.json').version;
    assert.ok(Number(version.split('.')[1]) >= 9, `outdated xmldom ${version}`);
    const { DOMParser } = fromEpub('@xmldom/xmldom');
    const xml = new DOMParser().parseFromString(
        '<package><metadata><description>&lt;b&gt;safe&lt;/b&gt;</description></metadata></package>',
        'application/xml',
    );
    assert.equal(xml.getElementsByTagName('description')[0].textContent, '<b>safe</b>');
});

test('clipboard image detection does not load file-type in the extension host', () => {
    const manifest = require('../../package.json');
    assert.equal(Object.hasOwn(manifest.dependencies, 'file-type'), false);
});
