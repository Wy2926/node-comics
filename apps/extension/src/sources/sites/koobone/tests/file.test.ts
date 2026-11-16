import {IDBFactory} from 'fake-indexeddb';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {selectedFile} from '../file';

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const ids = ['a'.repeat(32), 'b'.repeat(32)];
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('KOOBONE', 10);
    request.onupgradeneeded = () => request.result.createObjectStore('book_vol', {keyPath: 'file_md5'});
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('book_vol', 'readwrite');
      ids.forEach((id, i) => tx.objectStore('book_vol').put({file_md5: id, vol_name: 'Same title', file_blob: new Blob(['epub ' + i])}));
      tx.oncomplete = () => {db.close(); resolve();};
    };
  });
  let click: (event: Event) => void = () => {};
  const document = {addEventListener: (_: string, fn: typeof click) => {click = fn;}, removeEventListener: vi.fn()} as unknown as Document;
  const controller = new AbortController(), selected = selectedFile({document, signal: controller.signal, location: {} as any});
  selected.observe();
  const open = (id: string) => click({target: {closest: () => ({getAttribute: () => `vol_open('${id}');`})}} as any);
  return {selected, ids, open, controller, document};
}
describe('KOOBONE complete file selection', () => {
  it('requires an explicit book selection and distinguishes same-name books at the same URL', async () => {
    const f = await fixture();
    await expect(f.selected.openFile()).rejects.toThrow('重新打开');
    for (const [i, id] of f.ids.entries()) {
      f.open(id); const result = await f.selected.openFile();
      expect(result.id).toBe(id); expect(result.file.name).toBe('Same title.epub');
      expect(await result.file.text()).toBe('epub ' + i);
    }
    f.open('c'.repeat(32)); await expect(f.selected.openFile()).rejects.toThrow('完成下载');
    f.controller.abort(); await expect(f.selected.openFile()).rejects.toThrow();
    f.selected.dispose(); expect(f.document.removeEventListener).toHaveBeenCalledOnce();
  });
});
