import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEmf } from '../../src/react/view/word/emfValidation.ts';

function minimalEmf() {
    const bytes = new ArrayBuffer(108); const v = new DataView(bytes);
    v.setUint32(0, 1, true); v.setUint32(4, 88, true);
    v.setUint32(16, 100, true); v.setUint32(20, 50, true);
    v.setUint32(40, 0x464d4520, true);
    v.setUint32(88, 14, true); v.setUint32(92, 20, true);
    return bytes;
}
test('validates EMF dimensions and rejects truncated or non-progressing records', () => {
    assert.deepEqual(validateEmf(minimalEmf()), {width:100,height:50});
    assert.throws(() => validateEmf(minimalEmf().slice(0,100)), /record/);
    const bytes=minimalEmf(); new DataView(bytes).setUint32(92,0,true);
    assert.throws(() => validateEmf(bytes), /record/);
    const huge=minimalEmf(); new DataView(huge).setUint32(16,100000,true);
    assert.throws(() => validateEmf(huge), /dimensions/);
    const noEof=minimalEmf(); new DataView(noEof).setUint32(88,70,true);
    assert.throws(() => validateEmf(noEof), /Incomplete/);
});
