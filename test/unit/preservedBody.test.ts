import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { preparePreservedBody } from '../../src/react/view/word/preservedBody.ts';

const dom = new JSDOM();
Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
test('changing alignment retains paragraph properties omitted by the editor', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:keepNext/><w:jc w:val="left"/></w:pPr><w:r><w:t>Text</w:t></w:r></w:p></w:body></w:document>`);
    const session = await preparePreservedBody(await zip.generateAsync({type:'arraybuffer'}));
    const current = await JSZip.loadAsync(session.buffer);
    current.file('word/document.xml',(await current.file('word/document.xml')!.async('string')).replace('<w:keepNext/>',''));
    await session.capture(await current.generateAsync({type:'arraybuffer'}));
    current.file('word/document.xml',(await current.file('word/document.xml')!.async('string')).replace('w:val="left"','w:val="center"'));
    const saved = await JSZip.loadAsync(await session.save(await current.generateAsync({type:'arraybuffer'})));
    assert.match(await saved.file('word/document.xml')!.async('string'), /keepNext/);
    assert.match(await saved.file('word/document.xml')!.async('string'), /w:val="center"/);
});
test('saves inserted/deleted paragraphs and relocated opaque blocks using original object XML', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', `<w:document xmlns:w="${W}" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body><w:p><w:r><w:t>Delete me</w:t></w:r></w:p><w:p><w:r><w:object><o:OLEObject ProgID="Visio.Drawing.15"/></w:object></w:r></w:p><w:sectPr/></w:body></w:document>`);
    zip.file('word/embeddings/visio.bin', new Uint8Array([4, 5, 6]));
    const session = await preparePreservedBody(await zip.generateAsync({type:'arraybuffer'}));
    const current = await JSZip.loadAsync(session.buffer);
    current.file('word/document.xml', (await current.file('word/document.xml')!.async('string')).replace(/<w:object>[\s\S]*?<\/w:object>/, '<w:drawing/>'));
    await session.capture(await current.generateAsync({type:'arraybuffer'}));
    const doc = new DOMParser().parseFromString(await current.file('word/document.xml')!.async('string'), 'application/xml');
    const body = doc.getElementsByTagNameNS(W, 'body')[0];
    const object = doc.getElementsByTagNameNS(W, 'drawing')[0].parentElement!.parentElement!;
    for (const p of Array.from(doc.getElementsByTagNameNS(W, 'p'))) if (p !== object) p.remove();
    body.insertBefore(object, body.firstChild);
    for (let i = 0; i < 3; i++) {
        const p = doc.createElementNS(W, 'w:p');
        p.setAttributeNS('http://schemas.microsoft.com/office/word/2010/wordml', 'w14:paraId', `2000000${i}`);
        const r = doc.createElementNS(W, 'w:r'), t = doc.createElementNS(W, 'w:t');
        t.textContent = `New paragraph ${i}`; r.appendChild(t); p.appendChild(r);
        body.insertBefore(p, body.lastChild);
    }
    current.file('word/document.xml', new XMLSerializer().serializeToString(doc));
    const saved = await JSZip.loadAsync(await session.save(await current.generateAsync({type:'arraybuffer'})));
    const xml = await saved.file('word/document.xml')!.async('string');
    assert.match(xml, /OLEObject[\s\S]*New paragraph 0[\s\S]*New paragraph 2/);
    assert.doesNotMatch(xml, /Delete me|w:drawing/);
    assert.deepEqual(await saved.file('word/embeddings/visio.bin')!.async('uint8array'), new Uint8Array([4, 5, 6]));
    object.remove();
    current.file('word/document.xml', new XMLSerializer().serializeToString(doc));
    await assert.rejects(() => current.generateAsync({type:'arraybuffer'}).then(b => session.save(b)), /嵌入|保护/);
});
test('patches an ordinary paragraph while retaining object XML and all other package bytes', async () => {
    const zip=new JSZip();
    zip.file('word/document.xml', `<w:document xmlns:w="${W}" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:p><w:r><w:object><o:OLEObject ProgID="Visio.Drawing.15"/></w:object></w:r></w:p></w:body></w:document>`);
    zip.file('word/embeddings/visio.bin',new Uint8Array([1,2,3]));
    zip.file('word/_rels/document.xml.rels','original relationships');
    const session=await preparePreservedBody(await zip.generateAsync({type:'arraybuffer'}));
    const baseline=await JSZip.loadAsync(session.buffer);
    // Simulate the editor's lossy object serialization and relationship rewriting.
    const xml=await baseline.file('word/document.xml')!.async('string');
    baseline.file('word/document.xml',xml.replace(/<w:object>.*?<\/w:object>/,'<w:drawing/>'));
    baseline.file('word/_rels/document.xml.rels','editor relationships');
    await session.capture(await baseline.generateAsync({type:'arraybuffer'}));
    const current=await baseline.file('word/document.xml')!.async('string');
    baseline.file('word/document.xml',current.replace('Before','After &amp; 中文'));
    const saved=await JSZip.loadAsync(await session.save(await baseline.generateAsync({type:'arraybuffer'})));
    assert.match(await saved.file('word/document.xml')!.async('string'),/After &amp; 中文/);
    assert.match(await saved.file('word/document.xml')!.async('string'),/OLEObject/);
    assert.equal(await saved.file('word/_rels/document.xml.rels')!.async('string'),'original relationships');
    assert.deepEqual(await saved.file('word/embeddings/visio.bin')!.async('uint8array'),new Uint8Array([1,2,3]));
    baseline.file('word/document.xml',(await baseline.file('word/document.xml')!.async('string')).replace('<w:drawing/>',''));
    const damaged=await baseline.generateAsync({type:'arraybuffer'});
    await assert.rejects(()=>session.save(damaged), /超出正文编辑范围/);
});

test('rejects changed relationships and unknown inline content instead of silently dropping them', async () => {
    const zip=new JSZip();
    zip.file('word/document.xml',`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`);
    zip.file('word/_rels/document.xml.rels','original');
    const session=await preparePreservedBody(await zip.generateAsync({type:'arraybuffer'}));
    await session.capture(session.buffer);
    const changed=await JSZip.loadAsync(session.buffer);
    changed.file('word/_rels/document.xml.rels','changed');
    await assert.rejects(()=>changed.generateAsync({type:'arraybuffer'}).then(b=>session.save(b)),/超出正文编辑范围/);
    changed.file('word/_rels/document.xml.rels','original');
    changed.file('word/document.xml',(await changed.file('word/document.xml')!.async('string')).replace('<w:t>Hello</w:t>','<w:drawing/>'));
    await assert.rejects(()=>changed.generateAsync({type:'arraybuffer'}).then(b=>session.save(b)),/超出正文编辑范围/);
});

test('locks paragraphs whose original character properties are lost by the editor baseline', async () => {
    const zip=new JSZip();
    zip.file('word/document.xml',`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:rPr><w:bCs/><w:lang w:val="en-US" w:eastAsia="ja-JP"/></w:rPr><w:t>Mixed</w:t></w:r></w:p></w:body></w:document>`);
    const session=await preparePreservedBody(await zip.generateAsync({type:'arraybuffer'}));
    const baseline=await JSZip.loadAsync(session.buffer);
    baseline.file('word/document.xml',(await baseline.file('word/document.xml')!.async('string')).replace(/<w:rPr>.*?<\/w:rPr>/,''));
    await session.capture(await baseline.generateAsync({type:'arraybuffer'}));
    assert.equal(session.editableIds.size,0);
    baseline.file('word/document.xml',(await baseline.file('word/document.xml')!.async('string')).replace('Mixed','Changed'));
    await assert.rejects(()=>baseline.generateAsync({type:'arraybuffer'}).then(b=>session.save(b)),/超出正文编辑范围/);
});
