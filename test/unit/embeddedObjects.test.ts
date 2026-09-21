import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { hasEmbeddedOfficeObjects } from '../../src/react/view/word/embeddedObjects.ts';

test('finds embedded objects in headers and package relations; normal pictures remain editable', async () => {
    const zip=new JSZip(); zip.file('word/document.xml','<w:document><w:drawing/></w:document>');
    assert.equal(await hasEmbeddedOfficeObjects(await zip.generateAsync({type:'arraybuffer'})),false);
    zip.file('word/header1.xml','<w:hdr><o:OLEObject r:id="r1"/></w:hdr>');
    assert.equal(await hasEmbeddedOfficeObjects(await zip.generateAsync({type:'arraybuffer'})),true);
    zip.remove('word/header1.xml');zip.file('word/_rels/document.xml.rels', '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package"/>');
    assert.equal(await hasEmbeddedOfficeObjects(await zip.generateAsync({type:'arraybuffer'})),true);
});
