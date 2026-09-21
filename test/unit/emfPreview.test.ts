import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installEmfPreviews } from '../../src/react/view/word/emfPreview.ts';

test('EMF preview changes only painted images, keeps dimensions, and follows repaints', async () => {
    const dom = new JSDOM('<main><div class="layout-image"><img width="400" src="data:image/x-emf;base64,AQID"></div><div contenteditable="true"><img src="data:image/x-emf;base64,AQID"></div></main>');
    const root = dom.window.document.querySelector('main')!;
    let calls = 0;
    const dispose = installEmfPreviews(root, async () => { calls++; return 'data:image/png;base64,AAAA'; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(root.querySelector('.layout-image img')!.getAttribute('src'), 'data:image/png;base64,AAAA');
    assert.equal(root.querySelector('.layout-image img')!.getAttribute('width'), '400');
    assert.equal(root.querySelector('[contenteditable] img')!.getAttribute('src'), 'data:image/x-emf;base64,AQID');
    root.querySelector('.layout-image')!.innerHTML = '<img src="data:image/x-emf;base64,AQID">';
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(root.querySelector('.layout-image img')!.getAttribute('src'), 'data:image/png;base64,AAAA');
    assert.equal(calls, 1);
    dispose(); dom.window.close();
});

test('late conversions cannot overwrite another image or a disposed document', async () => {
    const dom = new JSDOM('<main><div class="layout-image"><img src="data:image/emf;base64,AQID"></div></main>');
    const root = dom.window.document.querySelector('main')!;
    let complete!: (value: string) => void;
    const dispose = installEmfPreviews(root, () => new Promise(resolve => { complete = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const img = root.querySelector('img')!;
    img.src = 'data:image/png;base64,NEW';
    complete('data:image/png;base64,OLD');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(img.getAttribute('src'), 'data:image/png;base64,NEW');
    dispose();
    img.src = 'data:image/emf;base64,AAAA';
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(img.getAttribute('src'), 'data:image/emf;base64,AAAA');
    dom.window.close();
});

test('failed EMF previews keep their source and are not retried on unrelated mutations', async () => {
    const dom = new JSDOM('<main><div class="layout-image"><img src="data:image/emf;base64,AQID"></div></main>');
    const root = dom.window.document.querySelector('main')!;
    let calls = 0;
    const dispose = installEmfPreviews(root, async () => { calls++; throw new Error('Unsupported'); });
    await new Promise(resolve => setTimeout(resolve, 0));
    root.appendChild(dom.window.document.createElement('p'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    assert.equal(root.querySelector('img')!.getAttribute('src'), 'data:image/emf;base64,AQID');
    assert.match(root.querySelector('img')!.title, /原始对象未修改/);
    dispose(); dom.window.close();
});
