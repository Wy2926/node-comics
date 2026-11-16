import {msg} from '../../../i18n/runtime';
import type {SourcePageContext} from '../../contracts/page';

/** The URL is shared by every book. Bind selection to the source's explicit open action. */
export function selectedFile({document, signal}: SourcePageContext) {
  let selected = '', observing = false;
  const clicked = (event: Event) => {
    const element = event.target as Element | null;
    const action = element?.closest?.('[onclick]')?.getAttribute('onclick') ?? '';
    const match = /^\s*vol_open\(['"]([a-f0-9]{32})['"]\);?\s*$/i.exec(action);
    if (match) selected = match[1].toLowerCase();
  };
  return {
    observe() {if (!observing) {document.addEventListener('click', clicked, true); observing = true;}},
    dispose() {if (observing) document.removeEventListener('click', clicked, true); observing = false; selected = '';},
    async openFile() {
      signal.throwIfAborted();
      const id = selected;
      if (!id) throw Error(msg('请返回来源书架重新打开漫画，再导入。'));
      // Open only the known database and one selected key. Abort upgrades to avoid creating or changing it.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('KOOBONE');
        request.onupgradeneeded = () => request.transaction?.abort();
        request.onerror = () => reject(Error(msg('请等待来源阅读器完成下载后重试。')));
        request.onsuccess = () => resolve(request.result);
      });
      db.onversionchange = () => db.close();
      try {
        signal.throwIfAborted();
        const record = await new Promise<any>((resolve, reject) => {
          const tx = db.transaction('book_vol', 'readonly'), request = tx.objectStore('book_vol').get(id);
          const abort = () => {try {tx.abort();} catch { /* Already complete. */ }};
          signal.addEventListener('abort', abort, {once: true});
          tx.oncomplete = () => {signal.removeEventListener('abort', abort); resolve(request.result);};
          tx.onabort = tx.onerror = () => {signal.removeEventListener('abort', abort); reject(tx.error ?? Error('SOURCE_RESOURCE_EXPIRED'));};
        });
        signal.throwIfAborted();
        if (selected !== id) throw Error('SOURCE_RESOURCE_EXPIRED');
        if (record?.file_md5 !== id || !(record.file_blob instanceof Blob) || !record.file_blob.size)
          throw Error(msg('请等待来源阅读器完成下载后重试。'));
        const name = String(record.vol_name || id).replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 180).replace(/\.epub$/i, '') + '.epub';
        return {id, file: new File([record.file_blob], name, {type: 'application/epub+zip'})};
      } finally {db.close();}
    },
  };
}
