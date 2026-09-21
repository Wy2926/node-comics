import type {AuthState} from './model';

// Firefox cannot restrict storage.local to trusted contexts. Extension-origin
// IndexedDB is shared by its pages/background, but not website content scripts.
async function database():Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('node-comics-auth',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('auth');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function access(mode:IDBTransactionMode,value?:AuthState):Promise<AuthState|undefined>{
  const db=await database();
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction('auth',mode),store=tx.objectStore('auth');
      const request=mode==='readonly'?store.get('current'):store.put(value,'current');
      tx.oncomplete=()=>resolve(mode==='readonly'?request.result:undefined);
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error??new Error('Auth transaction aborted'));
    });
  }finally{db.close();}
}
export const readPrivateAuth=()=>access('readonly');
export const writePrivateAuth=(value:AuthState)=>access('readwrite',value);
