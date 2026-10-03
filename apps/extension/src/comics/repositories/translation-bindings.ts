import {openSourceDatabase, type DatabaseSchema} from '../../storage/database';
import type {TranslationBinding} from '../domain';

/** Channel bindings start a separate baseline; source catalogs and positions stay intact. */
const schema:DatabaseSchema={
  translationBindings:{keyPath:'id',indexes:[{name:'imageSha256',keyPath:'imageSha256'},{name:'scope',keyPath:'scope'}]},
  tombstones:{keyPath:'id'},
};
let opening:Promise<IDBDatabase>|undefined;
export function openTranslationBindings():Promise<IDBDatabase>{
  return opening??=openSourceDatabase('channel-bindings',schema,()=>{opening=undefined;}).catch(error=>{opening=undefined;throw error;});
}
export async function blockTranslationBindingEntry(entryId:string):Promise<void>{
  const database=await openTranslationBindings();await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction('tombstones','readwrite');tx.objectStore('tombstones').put({id:'entry:'+entryId,deletedAt:Date.now()});
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
export async function readImageTranslationBindings(imageSha256:string):Promise<TranslationBinding[]>{
  const database=await openTranslationBindings();return new Promise((resolve,reject)=>{
    const tx=database.transaction('translationBindings'),rows=tx.objectStore('translationBindings').index('imageSha256').getAll(imageSha256,100);
    tx.oncomplete=()=>resolve(rows.result);tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
/** Call only after all referenced result bytes in this page have been reclaimed. */
export async function removeImageTranslationBindings(imageSha256:string,ids:readonly string[]):Promise<void>{
  const database=await openTranslationBindings();await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction('translationBindings','readwrite'),store=tx.objectStore('translationBindings');
    for(const id of ids){const row=store.get(id);row.onsuccess=()=>{if(row.result?.imageSha256===imageSha256)store.delete(id);};}
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
