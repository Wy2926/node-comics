import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindImageImport } from '../src/lib/image-import-events';

test('page paste and drag import batches once, preserve text editing and clean up listeners', () => {
  class ElementStub { constructor(public editable = false) {} closest() { return this.editable ? this : null; } }
  const previous = globalThis.Element;
  Object.assign(globalThis, { Element: ElementStub });
  const root = new EventTarget(), batches: File[][] = [];
  const files = [new File(['one'], 'one.png', {type:'image/png'}), new File(['two'], 'two.webp', {type:'image/webp'})];
  const dispatch = (type: string, data: object, handled = false) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(data)) Object.defineProperty(event, key, {value});
    if (handled) event.preventDefault();
    root.dispatchEvent(event);
    return event;
  };
  const remove = bindImageImport(root as unknown as Document, batch => batches.push(batch));
  try {
    assert.equal(dispatch('paste', {clipboardData:{files},target:new ElementStub()}).defaultPrevented,true);
    assert.deepEqual(batches,[files]);
    assert.equal(dispatch('paste', {clipboardData:{files},target:new ElementStub(true)}).defaultPrevented,false);
    assert.equal(dispatch('paste', {clipboardData:{files:[]}}).defaultPrevented,false);
    dispatch('paste', {clipboardData:{files}}, true);
    assert.equal(batches.length,1);
    assert.equal(dispatch('dragover', {dataTransfer:{types:['Files']}}).defaultPrevented,true);
    assert.equal(dispatch('dragover', {dataTransfer:{types:['text/plain']}}).defaultPrevented,false);
    dispatch('drop', {dataTransfer:{types:['Files'],files}});
    dispatch('drop', {dataTransfer:{types:['Files'],files}},true);
    assert.deepEqual(batches,[files,files]);
    remove();
    dispatch('paste', {clipboardData:{files}});
    assert.equal(batches.length,2);
  } finally { remove(); Object.assign(globalThis, {Element:previous}); }
});
