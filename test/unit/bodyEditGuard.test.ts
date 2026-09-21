import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { createBodyEditGuard, moveBodyBlock, insertBodyParagraph } from '../../src/react/view/word/bodyEditGuard.ts';

test('permits paragraph splits and block moves but blocks changes to protected contents', () => {
    const schema=new Schema({nodes:{doc:{content:'paragraph+'},paragraph:{content:'inline*',attrs:{paraId:{default:null}}},text:{group:'inline'},image:{inline:true,group:'inline',attrs:{src:{}}}},marks:{bold:{}}});
    const doc=schema.node('doc',null,[schema.node('paragraph',{paraId:'10000000'},[schema.text('hello')]),schema.node('paragraph',{paraId:'10000001'},[schema.node('image',{src:'original.emf'})])]);
    let blocked=0;
    let state=EditorState.create({schema,doc,plugins:[createBodyEditGuard(new Set(['10000000']),()=>blocked++)]});
    state=state.apply(state.tr.insertText('new ',1));
    assert.equal(state.doc.firstChild!.textContent,'new hello');
    state=state.apply(state.tr.addMark(1,4,schema.marks.bold.create()));
    assert.equal(state.doc.firstChild!.firstChild!.marks[0].type.name,'bold');
    state=state.apply(state.tr.split(2));
    assert.equal(state.doc.childCount,3);
    const object=state.doc.lastChild!;
    state=state.apply(state.tr.delete(state.doc.content.size-object.nodeSize,state.doc.content.size).insert(0,object));
    assert.equal(state.doc.firstChild!.firstChild!.type.name,'image');
    const before=state.doc;
    const imagePosition=1;
    state=state.apply(state.tr.delete(imagePosition,imagePosition+1));
    assert.ok(state.doc.eq(before));
    state=state.apply(state.tr.setSelection(TextSelection.create(state.doc,1)));
    assert.equal(state.selection.from,1);
    assert.equal(blocked,1);
});

test('block commands insert around an object and move the complete protected block', () => {
    const schema = new Schema({nodes:{doc:{content:'paragraph+'},paragraph:{content:'inline*',attrs:{paraId:{default:null}}},text:{group:'inline'},image:{inline:true,group:'inline',attrs:{src:{}}}}});
    const object = schema.node('paragraph',{paraId:'object'},[schema.node('image',{src:'original.emf'})]);
    let state = EditorState.create({schema,doc:schema.node('doc',null,[object]),plugins:[createBodyEditGuard(new Set(),()=>{})]});
    const view = { get state() { return state; }, dispatch(tr) { state = state.apply(tr); }, focus() {} };
    assert.equal(insertBodyParagraph(view, -1), true);
    assert.equal(state.doc.childCount,2);
    state = state.apply(state.tr.insertText('Before'));
    assert.equal(state.doc.firstChild!.textContent, 'Before');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc,state.doc.firstChild!.nodeSize+1)));
    assert.equal(moveBodyBlock(view, -1), true);
    assert.ok(state.doc.firstChild!.eq(object));
    assert.equal(insertBodyParagraph(view, 1), true);
    assert.equal(state.doc.childCount,3);
    state = state.apply(state.tr.insertText('After'));
    assert.equal(state.doc.child(1).textContent, 'After');
});
