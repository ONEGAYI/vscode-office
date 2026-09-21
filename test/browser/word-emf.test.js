'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const ROOT = path.resolve(__dirname, '../..');
const browserPath = process.env.BROWSER_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));

function rectangleEmf() {
    const header = Buffer.alloc(108);
    header.writeUInt32LE(1, 0); header.writeUInt32LE(108, 4);
    header.writeInt32LE(160, 16); header.writeInt32LE(100, 20);
    header.writeUInt32LE(0x464d4520, 40); header.writeUInt32LE(0x10000, 44);
    const brush = Buffer.alloc(24); brush.writeUInt32LE(39); brush.writeUInt32LE(24, 4); brush.writeUInt32LE(1, 8); brush.writeUInt32LE(0xc47244, 16);
    const select = Buffer.alloc(12); select.writeUInt32LE(37); select.writeUInt32LE(12, 4); select.writeUInt32LE(1, 8);
    const polygon = Buffer.alloc(68); polygon.writeUInt32LE(3); polygon.writeUInt32LE(68, 4); polygon.writeUInt32LE(5, 24);
    [10,10,150,10,150,90,10,90,10,10].forEach((n,i)=>polygon.writeInt32LE(n,28+i*4));
    const eof = Buffer.alloc(20); eof.writeUInt32LE(14); eof.writeUInt32LE(20, 4);
    const data = Buffer.concat([header,brush,select,polygon,eof]);
    data.writeUInt32LE(data.length,48); data.writeUInt32LE(5,52);
    return data;
}

test('Word paints EMF previews without rewriting embedded source data', { skip: !browserPath && 'Set BROWSER_PATH' }, async t => {
    const { createServer } = await import('vite');
    const { default: react } = await import('@vitejs/plugin-react');
    const { emfWorkerPlugin } = await import('../../vite/emfWorkerPlugin.ts');
    const { default: puppeteer } = await import('puppeteer-core');
    let emf = rectangleEmf(), embedded = Buffer.from('synthetic embedded payload');
    if (process.env.VISIO_SAMPLE_PATH) {
        embedded = fs.readFileSync(process.env.VISIO_SAMPLE_PATH);
        emf = await (await JSZip.loadAsync(embedded)).file('docProps/thumbnail.emf').async('nodebuffer');
    }
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="emf" ContentType="image/x-emf"/><Default Extension="vsdx" ContentType="application/vnd.ms-visio.drawing"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>EMF preview smoke</w:t></w:r></w:p><w:p><w:r><w:object><v:shape id="VisioShape" style="width:400pt;height:317pt"><v:imagedata r:id="rImg"/></v:shape><o:OLEObject Type="Embed" ProgID="Visio.Drawing.15" ShapeID="VisioShape" DrawAspect="Content" r:id="rOle"/></w:object></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>');
    zip.file('word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.emf"/><Relationship Id="rOle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="embeddings/diagram.vsdx"/></Relationships>');
    zip.file('word/media/image1.emf',emf);zip.file('word/embeddings/diagram.vsdx',embedded);
    const buffer = await zip.generateAsync({type:'nodebuffer'});
    if (process.env.WORD_EMF_OUTPUT) {
        fs.mkdirSync(process.env.WORD_EMF_OUTPUT,{recursive:true});
        fs.writeFileSync(path.join(process.env.WORD_EMF_OUTPUT,'visio-embedded.docx'),buffer);
    }
    const server = await createServer({configFile:false,root:ROOT,plugins:[react(),emfWorkerPlugin()],define:{global:'globalThis'},server:{host:'127.0.0.1',port:0},logLevel:'error'});
    await server.listen(); t.after(()=>server.close());
    // VSCode hosts the document on its own origin while loading Vite modules from localhost.
    const devOrigin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const html = await server.transformIndexHtml('/test/browser/fixtures/word-emf.html', fs.readFileSync(path.join(__dirname,'fixtures/word-emf.html'),'utf8'));
    const hostedHtml = html.replace(/(["'])\/(?!\/)/g, `$1${devOrigin}/`).replace('src="./word-emf.tsx"', `src="${devOrigin}/test/browser/fixtures/word-emf.tsx"`);
    const host = require('node:http').createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(hostedHtml);});
    await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>{host.closeAllConnections();host.close(resolve);}));
    const browser = await puppeteer.launch({executablePath:browserPath,headless:true}); t.after(()=>browser.close());
    const page = await browser.newPage(); await page.setViewport({width:1200,height:1000});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.evaluateOnNewDocument(bytes=>{
        window.saved=[];window.hostMessages=[];
        window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>{
            window.hostMessages.push(m.type);
            if(m.type==='init')setTimeout(()=>window.postMessage({type:'open',content:{buffer:bytes,fileName:'visio-embedded.docx',documentCacheId:'test'}},'*'),0);
            if(m.type==='save')window.saved.push(m.content);
        }});
    },[...buffer]);
    await page.goto(`http://127.0.0.1:${host.address().port}`);
    await page.waitForSelector('img[data-office-emf-preview="true"], img[alt="EMF 预览不可用"]',{timeout:15000});
    assert.ok(await page.$('img[data-office-emf-preview="true"]'),'EMF must render when the document and Vite modules have different origins');
    const info = await page.$eval('img[data-office-emf-preview="true"]',img=>({src:img.src,width:img.naturalWidth,height:img.naturalHeight}));
    assert.match(info.src,/^data:image\/png;base64,/);
    assert.ok(info.width>0 && info.height>0);
    assert.equal(await page.evaluate(()=>window.hostMessages.filter(x=>x==='change').length),0,'painting must not dirty document');
    if(process.env.WORD_EMF_OUTPUT)await page.screenshot({path:path.join(process.env.WORD_EMF_OUTPUT,'word-preview.png'),fullPage:true});
    await page.waitForSelector('[data-office-body-ready="true"]',{timeout:8000});
    await page.waitForSelector('[contenteditable="true"]',{timeout:8000});
    assert.ok(await page.$('button[aria-label="折叠嵌入提示"]'), 'banner has a left-hand collapse control');
    const changesBeforeCollapse = await page.evaluate(()=>window.hostMessages.filter(x=>x==='change').length);
    await page.click('button[aria-label="折叠嵌入提示"]');
    assert.ok(await page.$('button[aria-label="展开嵌入提示"][aria-expanded="false"]'));
    assert.ok(await page.$eval('.word-embedded-banner',el=>el.getBoundingClientRect().height<=32), 'collapsed banner is a compact single row');
    assert.equal(await page.$eval('[aria-label="段落与嵌入块布局"]',el=>el.getClientRects().length),0);
    await page.keyboard.press('Enter');
    assert.ok(await page.$('button[aria-label="折叠嵌入提示"][aria-expanded="true"]'));
    assert.ok(await page.$eval('[aria-label="段落与嵌入块布局"]',el=>el.getClientRects().length>0));
    assert.equal(await page.evaluate(()=>window.hostMessages.filter(x=>x==='change').length),changesBeforeCollapse, 'collapsing does not edit the document');
    await new Promise(resolve=>setTimeout(resolve,200));
    await page.click('.layout-run-text');
    await page.keyboard.press('Home');await page.keyboard.type('Edited ');
    await page.waitForFunction(()=>document.querySelector('.word-viewer').textContent.includes('Edited EMF preview smoke'),{timeout:3000});
    // Create as many ordinary paragraphs as needed before the object.
    await page.click('button::-p-text(后插段落)');
    await page.keyboard.type('Text before Visio');
    await page.waitForFunction(()=>document.querySelector('.word-viewer').textContent.includes('Text before Visio'),{timeout:3000});
    await page.keyboard.press('Enter');await page.keyboard.type('Another paragraph before Visio');
    // Select the object and insert a paragraph after it through the visible toolbar.
    await page.click('img[data-office-emf-preview="true"]');
    await page.keyboard.press('Delete');
    assert.ok(await page.$('.ProseMirror img'), 'the embedded block remains protected');
    assert.equal(await page.$('.ant-alert-warning'), null, 'protection guidance must not duplicate the persistent banner');
    await page.click('button::-p-text(后插段落)');
    await page.keyboard.type('Text after Visio');
    await page.waitForFunction(()=>document.querySelector('.word-viewer').textContent.includes('Text after Visio'),{timeout:3000});
    await page.keyboard.down('Control');await page.keyboard.press('KeyS');await page.keyboard.up('Control');
    await page.waitForFunction(()=>window.saved.length>0 || document.querySelector('.ant-alert-warning'),{timeout:10000});
    assert.ok(await page.evaluate(()=>window.saved.length>0), await page.evaluate(()=>document.querySelector('.ant-alert-warning')?.textContent));
    const savedBytes=Buffer.from(await page.evaluate(()=>window.saved[0]));
    const saved=await JSZip.loadAsync(savedBytes);
    const savedXml=await saved.file('word/document.xml').async('string');
    assert.match(savedXml,/Edited EMF preview smoke/);
    assert.match(savedXml,/OLEObject/);
    assert.match(savedXml,/rOle/);
    assert.match(savedXml,/Edited EMF preview smoke<\/w:t>[\s\S]*<w:p\b[^>]*><w:r><w:t>Text before Visio<\/w:t>[\s\S]*OLEObject/);
    assert.match(savedXml,/OLEObject[\s\S]*Text after Visio[\s\S]*sectPr/);
    assert.deepEqual(await saved.file('word/media/image1.emf').async('nodebuffer'),emf);
    assert.deepEqual(await saved.file('word/embeddings/diagram.vsdx').async('nodebuffer'),embedded);
    assert.equal(await saved.file('word/_rels/document.xml.rels').async('string'),await zip.file('word/_rels/document.xml.rels').async('string'));
    if(process.env.WORD_EMF_OUTPUT)fs.writeFileSync(path.join(process.env.WORD_EMF_OUTPUT,'visio-edited.docx'),savedBytes);
    // Paragraph count is no longer locked.
    const paragraphCount=await page.$$eval('.ProseMirror p',nodes=>nodes.length);
    await page.keyboard.press('Enter');
    assert.equal(await page.$$eval('.ProseMirror p',nodes=>nodes.length),paragraphCount+1);
    await page.keyboard.press('Backspace');
    assert.equal(await page.$$eval('.ProseMirror p',nodes=>nodes.length),paragraphCount);
    // Reopen the actual saved package, verify its object preview, then save a second edit.
    await page.evaluate(bytes=>{window.saved=[];window.postMessage({type:'open',content:{buffer:bytes,fileName:'visio-edited.docx',documentCacheId:'reopened'}},'*')},[...savedBytes]);
    await page.waitForFunction(()=>document.querySelector('[data-office-body-ready="true"]') && document.querySelector('.word-viewer')?.textContent.includes('Edited EMF preview smoke'));
    await page.waitForSelector('img[data-office-emf-preview="true"]');
    await new Promise(resolve=>setTimeout(resolve,200));
    await page.click('.layout-run-text');await page.keyboard.press('Home');
    await page.keyboard.down('Control');await page.keyboard.press('KeyB');await page.keyboard.up('Control');
    await page.keyboard.type('Again ');
    await page.waitForFunction(()=>document.querySelector('.word-viewer').textContent.includes('Again Edited EMF preview smoke'));
    await page.click('img[data-office-emf-preview="true"]');
    for (let i=0;i<3;i++) await page.click('button::-p-text(块上移)');
    await page.keyboard.down('Control');await page.keyboard.press('KeyS');await page.keyboard.up('Control');
    await page.waitForFunction(()=>window.saved.length>0);
    const secondBytes=Buffer.from(await page.evaluate(()=>window.saved.at(-1)));
    const second=await JSZip.loadAsync(secondBytes);
    assert.match(await second.file('word/document.xml').async('string'),/Again /);
    assert.match(await second.file('word/document.xml').async('string'),/<w:b(?:\s|\/|>)/);
    assert.match(await second.file('word/document.xml').async('string'),/OLEObject/);
    assert.match(await second.file('word/document.xml').async('string'),/OLEObject[\s\S]*Again /);
    assert.deepEqual(await second.file('word/embeddings/diagram.vsdx').async('nodebuffer'),embedded);
    assert.deepEqual(await second.file('word/media/image1.emf').async('nodebuffer'),emf);
    assert.equal(await second.file('word/_rels/document.xml.rels').async('string'),await zip.file('word/_rels/document.xml.rels').async('string'));
    if(process.env.WORD_EMF_OUTPUT)fs.writeFileSync(path.join(process.env.WORD_EMF_OUTPUT,'visio-layout-edited.docx'),secondBytes);
    if(process.env.WORD_EMF_OUTPUT)await page.screenshot({path:path.join(process.env.WORD_EMF_OUTPUT,'word-body-edited.png'),fullPage:true});
    await page.evaluate(bytes=>{window.saved=[];window.postMessage({type:'open',content:{buffer:bytes,fileName:'visio-layout-edited.docx',documentCacheId:'moved'}},'*')},[...secondBytes]);
    await page.waitForSelector('[data-office-body-ready="true"]');
    await page.waitForSelector('img[data-office-emf-preview="true"]');
    assert.ok(await page.$eval('.ProseMirror p',p=>!!p.querySelector('img')), 'moved object remains the first block after reopening');
    // Opening a normal DOCX afterwards must restore editing and saving.
    zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Ordinary document</w:t></w:r></w:p></w:body></w:document>');
    zip.remove('word/_rels/document.xml.rels');zip.remove('word/embeddings/diagram.vsdx');
    const plain=await zip.generateAsync({type:'nodebuffer'});
    await page.evaluate(bytes=>window.postMessage({type:'open',content:{buffer:bytes,fileName:'plain.docx',documentCacheId:'plain'}},'*'),[...plain]);
    await page.waitForSelector('[contenteditable="true"]');
    assert.equal(await page.$('[data-office-body-ready]'),null);
    await page.keyboard.down('Control');await page.keyboard.press('KeyS');await page.keyboard.up('Control');
    await page.waitForFunction(()=>window.saved.length>0);
    assert.deepEqual(errors,[]);
});
