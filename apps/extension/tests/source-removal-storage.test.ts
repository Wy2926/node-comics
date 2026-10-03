import {IDBFactory,IDBKeyRange,IDBIndex} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {sourceDatabaseName} from '../src/storage/database';

const request=<T>(value:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
const completed=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
beforeEach(()=>{vi.resetModules();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('upgrades the existing container database without changing bytes, then removes only indexed partial imports',async()=>{
  const opening=indexedDB.open(sourceDatabaseName('container-bytes'),1);
  opening.onupgradeneeded=()=>{
    const db=opening.result;
    const objects=db.createObjectStore('objects',{keyPath:'id'});objects.createIndex('state','state');
    const chunks=db.createObjectStore('chunks',{keyPath:'id'});chunks.createIndex('objectId','objectId');
    const operations=db.createObjectStore('operations',{keyPath:'id'});operations.createIndex('expiresAt','expiresAt');
    const references=db.createObjectStore('references',{keyPath:'id'});references.createIndex('containerId','containerId');references.createIndex('referenceId','referenceId');
    const leases=db.createObjectStore('leases',{keyPath:'id'});leases.createIndex('containerId','containerId');db.createObjectStore('settings',{keyPath:'id'});
  };
  const original=await request(opening),tx=original.transaction(Array.from(original.objectStoreNames),'readwrite'),done=completed(tx);
  tx.objectStore('settings').put({id:'backend',value:'chunked-idb-v1'});
  tx.objectStore('objects').put({id:'retained-container',objectId:'original',sha256:'original',size:3,format:'cbz',generation:1,state:'ready',availability:'present',backend:'chunked-idb-v1'});
  tx.objectStore('chunks').put({id:'original:0',objectId:'original',ordinal:0,bytes:new Uint8Array([7,8,9]).buffer});
  tx.objectStore('references').put({id:JSON.stringify(['retained-container','other-entry']),containerId:'retained-container',referenceId:'other-entry'});
  for(let index=0;index<205;index++){
    const id='partial:'+index;
    tx.objectStore('operations').put({id,referenceId:'removed-entry',size:1,written:1,format:'cbz',fileName:'partial.cbz',expiresAt:Date.now()+10000,generation:1,state:'staging'});
    tx.objectStore('chunks').put({id:id+':0',objectId:id,ordinal:0,bytes:new Uint8Array([1]).buffer});
  }
  tx.objectStore('operations').put({id:'other-partial',referenceId:'other-entry',size:1,written:0,expiresAt:Date.now()+10000});
  await done;original.close();
  const {byteDatabase,bytesTransaction,idbRequest}=await import('../src/storage/bytes/database');
  const database=await byteDatabase();expect(database.version).toBe(2);expect(database.transaction('operations').objectStore('operations').indexNames.contains('referenceId')).toBe(true);
  const {discardContainerImports,openContainer}=await import('../src/storage/containers');
  const reads=vi.spyOn(IDBIndex.prototype,'getAll');
  await discardContainerImports('removed-entry');
  const operationReads=reads.mock.calls.filter((_,index)=>(reads.mock.contexts[index] as IDBIndex).objectStore.name==='operations');
  expect(operationReads).toEqual([['removed-entry',100],['removed-entry',100],['removed-entry',100]]);
  reads.mockRestore();
  expect(await bytesTransaction(['operations'],'readonly',tx=>idbRequest(tx.objectStore('operations').getAll()))).toEqual([expect.objectContaining({id:'other-partial'})]);
  expect(await bytesTransaction(['chunks'],'readonly',tx=>idbRequest(tx.objectStore('chunks').getAll()))).toEqual([expect.objectContaining({id:'original:0',bytes:new Uint8Array([7,8,9]).buffer})]);
  const source=await openContainer('retained-container');expect(await source.readAt(0,3)).toEqual(new Uint8Array([7,8,9]));await source.close();database.close();
});
