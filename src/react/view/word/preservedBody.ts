import JSZip from 'jszip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const blocked = '此操作超出正文编辑范围：改变了受保护内容或不支持的文档数据，未保存；请撤销该操作。';
const runProperties = new Set(['b', 'bCs', 'i', 'iCs', 'u', 'strike', 'dstrike', 'sz', 'szCs', 'rFonts', 'color', 'highlight', 'vertAlign', 'lang', 'spacing', 'position', 'kern', 'caps', 'smallCaps']);
const parse = (xml: string) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('无法解析文档 XML');
    return doc;
};
const serialize = (node: Node) => new XMLSerializer().serializeToString(node);
const paragraphs = (doc: Document) => Array.from(doc.getElementsByTagNameNS(W, 'p'));
const idOf = (p: Element) => p.getAttributeNS(W14, 'paraId') || '';

// Preserve all paragraph properties; only supported simple runs can be rewritten.
function simpleParagraph(p: Element) {
    return Array.from(p.children).every(child => {
        if (child.namespaceURI !== W) return false;
        if (child.localName === 'pPr') return true;
        if (child.localName !== 'r') return false;
        return Array.from(child.children).every(run => {
            if (run.namespaceURI !== W) return false;
            if (run.localName === 'rPr') return Array.from(run.children).every(prop => prop.namespaceURI === W && runProperties.has(prop.localName) && !prop.children.length);
            return ['t', 'br', 'tab'].includes(run.localName) && !run.children.length;
        });
    });
}

function canonical(node: Node): unknown {
    if (node.nodeType === 9) return canonical((node as Document).documentElement);
    if (node.nodeType !== 1) return node.textContent;
    const el = node as Element;
    return [el.namespaceURI, el.localName,
        Array.from(el.attributes).filter(a => a.namespaceURI !== XMLNS).map(a => [a.namespaceURI, a.localName, a.value]).sort(),
        Array.from(el.childNodes).filter(n => n.nodeType === 1 || (n.nodeType === 3 && (el.localName === 't' || !!n.textContent?.trim()))).map(canonical)];
}
const equal = (a: Node, b: Node) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function paragraphMap(doc: Document) {
    const result = new Map<string, Element>();
    for (const p of paragraphs(doc)) {
        const id = idOf(p);
        if (!id || result.has(id)) throw new Error(blocked);
        result.set(id, p);
    }
    return result;
}
const bodyOf = (doc: Document) => doc.getElementsByTagNameNS(W, 'body')[0];
const blocksOf = (doc: Document) => Array.from(bodyOf(doc).children).filter(c => !(c.namespaceURI === W && c.localName === 'sectPr'));
function envelope(doc: Document) {
    const clone = doc.cloneNode(true) as Document;
    for (const block of blocksOf(clone)) block.remove();
    return clone;
}
const isParagraph = (el: Element) => el.namespaceURI === W && el.localName === 'p';
const runs = (p: Element) => JSON.stringify(Array.from(p.children).filter(c => c.localName !== 'pPr').map(canonical));
const properties = (p: Element) => Array.from(p.children).find(c => c.namespaceURI === W && c.localName === 'pPr');
// The editor's full serializer re-embeds unchanged data URLs under fresh names
// (including EMF bytes with a .png extension). Normalize only byte-identical copies.
async function normalizeCopiedImages(baseline: JSZip, edited: JSZip, doc: Document) {
    if (!Object.keys(edited.files).some(name => name.startsWith('word/media/') && !edited.files[name].dir && !baseline.file(name))) return;
    const relPath = 'word/_rels/document.xml.rels';
    const beforeFile = baseline.file(relPath), afterFile = edited.file(relPath);
    if (!beforeFile || !afterFile) return;
    const before = parse(await beforeFile.async('string')), after = parse(await afterFile.async('string'));
    const beforeRels = Array.from(before.documentElement.children);
    const copied = new Set<string>();
    for (const rel of Array.from(after.documentElement.children)) {
        if (beforeRels.some(b => b.getAttribute('Id') === rel.getAttribute('Id'))) continue;
        const target = rel.getAttribute('Target') || '';
        if (rel.getAttribute('Type') !== R + '/image' || rel.hasAttribute('TargetMode') || !/^media\/[^/]+$/.test(target)) continue;
        const path = 'word/' + target;
        if (baseline.file(path) || !edited.file(path)) continue;
        const bytes = await edited.file(path)!.async('uint8array');
        for (const candidate of beforeRels) {
            if (candidate.getAttribute('Type') !== R + '/image' || candidate.hasAttribute('TargetMode')) continue;
            const candidateTarget = candidate.getAttribute('Target') || '';
            if (!/^media\/[^/]+$/.test(candidateTarget)) continue;
            const file = baseline.file('word/' + candidateTarget);
            if (!file) continue;
            const known = await file.async('uint8array');
            if (known.length !== bytes.length || known.some((v, i) => v !== bytes[i])) continue;
            for (const el of Array.from(doc.getElementsByTagName('*'))) for (const attr of Array.from(el.attributes)) {
                if (attr.namespaceURI === R && attr.value === rel.getAttribute('Id')) attr.value = candidate.getAttribute('Id')!;
            }
            copied.add(path); rel.remove(); break;
        }
    }
    if (!copied.size) return;
    for (const path of copied) edited.remove(path);
    // Preserve byte comparison for unrelated relationship changes.
    if (!equal(before, after)) throw new Error(blocked);
    edited.file(relPath, await beforeFile.async('string'));
    const typePath = '[Content_Types].xml';
    if (baseline.file(typePath) && edited.file(typePath)) {
        const beforeTypes = parse(await baseline.file(typePath)!.async('string'));
        const afterTypes = parse(await edited.file(typePath)!.async('string'));
        const copiedExtensions = new Set(Array.from(copied, p => p.split('.').at(-1)));
        for (const type of Array.from(afterTypes.documentElement.children)) {
            if (type.localName === 'Default' && copiedExtensions.has(type.getAttribute('Extension') || '')
                && !Array.from(beforeTypes.documentElement.children).some(b => b.getAttribute('Extension') === type.getAttribute('Extension'))) type.remove();
        }
        if (!equal(beforeTypes, afterTypes)) throw new Error(blocked);
        edited.file(typePath, await baseline.file(typePath)!.async('string'));
    }
}
function patchParagraph(before: Element, original: Element, after: Element, doc: Document, editable: boolean) {
    const result = doc.importNode(original, true);
    const beforePr = properties(before), afterPr = properties(after);
    if (JSON.stringify(beforePr && canonical(beforePr)) !== JSON.stringify(afterPr && canonical(afterPr))) {
        if (afterPr?.getElementsByTagNameNS(W, 'sectPr').length || beforePr?.getElementsByTagNameNS(W, 'sectPr').length) throw new Error(blocked);
        let outputPr = properties(result);
        if (!outputPr) {
            outputPr = doc.createElementNS(W, 'w:pPr');
            result.insertBefore(outputPr, result.firstChild);
        }
        const key = (el: Element) => `${el.namespaceURI}:${el.localName}`;
        const oldChildren = Array.from(beforePr?.children || []), newChildren = Array.from(afterPr?.children || []);
        for (const name of new Set([...oldChildren, ...newChildren].map(key))) {
            const oldGroup = oldChildren.filter(c => key(c) === name), newGroup = newChildren.filter(c => key(c) === name);
            if (JSON.stringify(oldGroup.map(canonical)) === JSON.stringify(newGroup.map(canonical))) continue;
            const existing = Array.from(outputPr.children).filter(c => key(c) === name);
            const next = existing.at(-1)?.nextSibling || null;
            existing.forEach(c => c.remove());
            newGroup.forEach(c => outputPr!.insertBefore(doc.importNode(c, true), next));
        }
        if (!outputPr.children.length && !outputPr.attributes.length) outputPr.remove();
    }
    if (editable && runs(before) !== runs(after)) {
        for (const child of Array.from(result.childNodes)) if (child.nodeType !== 1 || (child as Element).localName !== 'pPr') child.remove();
        for (const run of Array.from(after.children)) if (run.localName === 'r') result.appendChild(doc.importNode(run, true));
    }
    return result;
}

export interface PreservedBodySession {
    buffer: ArrayBuffer;
    editableIds: Set<string>;
    ready: boolean;
    capture: (buffer: ArrayBuffer) => Promise<void>;
    save: (buffer: ArrayBuffer) => Promise<ArrayBuffer>;
}

/** Use the original ZIP as authority; never fall back to the editor's lossy full save. */
export async function preparePreservedBody(original: ArrayBuffer): Promise<PreservedBodySession> {
    const source = await JSZip.loadAsync(original);
    const entry = source.file('word/document.xml');
    if (!entry) throw new Error('缺少 document.xml');
    const originalDoc = parse(await entry.async('string'));
    originalDoc.documentElement.setAttributeNS(XMLNS, 'xmlns:w14', W14);
    // Stable paragraph IDs tie the editor back to the original XML, including files without IDs.
    const used = new Set(paragraphs(originalDoc).map(idOf));
    const seen = new Set<string>();
    let counter = 0x10000000;
    const editableIds = new Set<string>();
    for (const p of paragraphs(originalDoc)) {
        let id = idOf(p);
        if (!id || seen.has(id)) {
            do { id = (counter++).toString(16).toUpperCase(); } while (used.has(id));
            p.setAttributeNS(W14, 'w14:paraId', id); used.add(id);
        }
        seen.add(id);
        // Body/table paragraphs only, excluding text inside an object or text box.
        let ancestor = p.parentElement, inBody = false, protectedAncestor = false;
        while (ancestor) {
            if (ancestor.namespaceURI === W && ancestor.localName === 'body') inBody = true;
            if (['object', 'pict', 'drawing', 'txbxContent'].includes(ancestor.localName)) protectedAncestor = true;
            ancestor = ancestor.parentElement;
        }
        if (inBody && !protectedAncestor && simpleParagraph(p)) editableIds.add(id);
    }
    source.file('word/document.xml', serialize(originalDoc));
    const prepared = await source.generateAsync({ type: 'arraybuffer' });
    let baseline: JSZip | undefined, baselineDoc: Document | undefined;
    const session: PreservedBodySession = {
        buffer: prepared, editableIds, ready: false,
        async capture(buffer) {
            baseline = await JSZip.loadAsync(buffer);
            baselineDoc = parse(await baseline.file('word/document.xml')!.async('string'));
            await normalizeCopiedImages(source, baseline, baselineDoc);
            const map = paragraphMap(baselineDoc);
            for (const id of editableIds) if (!map.has(id)) throw new Error('编辑器未保留正文段落标识');
            // Even recognized OOXML properties can be lost by this editor version.
            // Only enable paragraphs whose runs survived the initial editor save intact.
            const originalParagraphs = paragraphMap(originalDoc);
            for (const id of editableIds) {
                if (runs(originalParagraphs.get(id)!) !== runs(map.get(id)!)) editableIds.delete(id);
            }
            const beforeBlocks = blocksOf(originalDoc), roundTrip = blocksOf(baselineDoc);
            if (beforeBlocks.length !== roundTrip.length || beforeBlocks.some((b, i) => b.localName !== roundTrip[i].localName || (isParagraph(b) && idOf(b) !== idOf(roundTrip[i])))) throw new Error('编辑器未保留受保护块的标识');
            session.ready = true;
        },
        async save(buffer) {
            if (!baseline || !baselineDoc || !session.ready) throw new Error('正文编辑尚未准备完成');
            const edited = await JSZip.loadAsync(buffer);
            const editedDoc = parse(await edited.file('word/document.xml')!.async('string'));
            await normalizeCopiedImages(baseline, edited, editedDoc);
            const fileNames = (zip: JSZip) => Object.keys(zip.files).filter(n => !zip.files[n].dir && n !== 'docProps/core.xml').sort();
            if (JSON.stringify(fileNames(baseline)) !== JSON.stringify(fileNames(edited))) throw new Error(blocked);
            for (const name of fileNames(baseline)) {
                if (name === 'word/document.xml') continue;
                const [before, after] = await Promise.all([baseline.file(name)!.async('uint8array'), edited.file(name)!.async('uint8array')]);
                if (before.length !== after.length || before.some((v, i) => v !== after[i])) throw new Error(blocked);
            }
            paragraphMap(editedDoc); // Reject duplicate or missing identities before reconstructing the body.
            if (!equal(envelope(baselineDoc), envelope(editedDoc))) throw new Error(blocked);
            const result = originalDoc.cloneNode(true) as Document;
            const originals = blocksOf(originalDoc), beforeBlocks = blocksOf(baselineDoc);
            const protectedIndexes = new Set(beforeBlocks.map((b, i) => !isParagraph(b) || !editableIds.has(idOf(b)) ? i : -1).filter(i => i >= 0));
            for (const block of blocksOf(result)) block.remove();
            const resultBody = bodyOf(result);
            const section = Array.from(resultBody.children).find(c => c.namespaceURI === W && c.localName === 'sectPr') || null;
            for (const after of blocksOf(editedDoc)) {
                const index = beforeBlocks.findIndex(b => isParagraph(after) ? isParagraph(b) && idOf(b) === idOf(after) : equal(b, after));
                let output: Element;
                if (index >= 0) {
                    const before = beforeBlocks[index];
                    const editable = isParagraph(before) && editableIds.has(idOf(before));
                    if (!editable) {
                        if (!protectedIndexes.delete(index) || (isParagraph(after) ? runs(before) !== runs(after) : !equal(before, after))) throw new Error(blocked);
                    } else if (!simpleParagraph(after)) throw new Error(blocked);
                    output = isParagraph(after) ? patchParagraph(before, originals[index], after, result, editable) : result.importNode(originals[index], true);
                } else {
                    if (!isParagraph(after) || !simpleParagraph(after) || after.getElementsByTagNameNS(W, 'sectPr').length) throw new Error(blocked);
                    output = result.importNode(after, true);
                }
                resultBody.insertBefore(output, section);
            }
            if (protectedIndexes.size) throw new Error(blocked);
            const output = await JSZip.loadAsync(prepared);
            output.file('word/document.xml', serialize(result));
            return output.generateAsync({ type: 'arraybuffer' });
        },
    };
    return session;
}
