import 'fake-indexeddb/auto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import type {Entry} from '../src/comics/domain';
import {cachedEntryIds,subscribeCachedEntries} from '../src/comics/application/offline-entries';
import {bookDownloadId,downloadTaskId} from '../src/comics/acquisition/book-model';
import {downloadKey,downloadStore} from '../src/storage/downloads';
import {sourceDatabaseName} from '../src/storage/database';

beforeEach(async()=>{vi.restoreAllMocks();await downloadStore.clear();});
async function entry(comicId:string=crypto.randomUUID(),extra:Partial<Entry>={}){
  const id=crypto.randomUUID(),value:Entry={id,comicId,title:'Chapter',order:0,format:'website',contentId:crypto.randomUUID(),generation:1,indexState:'ready',pageCount:2,knownTotal:2,discoveryComplete:true,createdAt:0,updatedAt:0,...extra};
  await catalog.put('entries',value);return value;
}
async function retain(value:Entry,count=2,contentId=value.contentId){
  for(let page=0;page<count;page++)await downloadStore.put(downloadKey(contentId,'page:'+page),new Blob(['original']),{owner:value.id,contentId});
}

describe('reader directory retained chapter state',()=>{
  it('includes every fully retained language and legacy entry without a current download plan',async()=>{
    const comicId=crypto.randomUUID(),zh=await entry(comicId,{contentLanguage:'zh-Hans'}),en=await entry(comicId,{contentLanguage:'en'}),ja=await entry(comicId,{contentLanguage:'ja'});
    await retain(zh);await retain(en);await retain(ja,1);
    await catalog.put('metadata',{id:bookDownloadId(comicId),languages:['zh-Hans'],entryIds:[zh.id]});
    const manifests=vi.spyOn(catalog,'listPages'),blobs=vi.spyOn(downloadStore,'get');
    expect(await cachedEntryIds([zh.id,en.id,ja.id,zh.id])).toEqual(new Set([zh.id,en.id]));
    expect(manifests).not.toHaveBeenCalled();expect(blobs).not.toHaveBeenCalled();
  });
  it('does not mark incomplete discovery, invalid totals or retained bytes from replaced content',async()=>{
    const unknown=await entry(undefined,{discoveryComplete:false}),mismatch=await entry(undefined,{knownTotal:3}),empty=await entry(undefined,{pageCount:0,knownTotal:0}),zero=await entry(undefined,{knownTotal:0}),replaced=await entry();
    for(const value of [unknown,mismatch,empty,zero])await retain(value);
    await retain(replaced,2,'old-content');
    expect(await cachedEntryIds([unknown,mismatch,empty,zero,replaced].map(value=>value.id))).toEqual(new Set());
  });
  it('verifies retained object presence and removes badges after clearing',async()=>{
    const value=await entry();await retain(value);
    expect(await cachedEntryIds([value.id])).toEqual(new Set([value.id]));
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const open=indexedDB.open(sourceDatabaseName('downloads'));open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('objects','readwrite');tx.objectStore('objects').delete(downloadKey(value.contentId,'page:1'));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
    expect(await cachedEntryIds([value.id])).toEqual(new Set());
    await retain(value);await downloadStore.deleteOwner(value.id);
    expect(await cachedEntryIds([value.id])).toEqual(new Set());
  });
  it('narrows progress updates to the matching entry and refreshes all entries for a book change',async()=>{
    const first=await entry(),second=await entry(first.comicId),other=await entry(),changed=vi.fn(),unsubscribe=subscribeCachedEntries(first.comicId,[first.id,second.id],changed);
    try{
      await catalog.put('tasks',{id:downloadTaskId(first.id),entryId:first.id,status:'complete'});
      expect(changed).toHaveBeenLastCalledWith([first.id]);changed.mockClear();
      await catalog.put('tasks',{id:downloadTaskId(other.id),entryId:other.id,status:'running'});
      expect(changed).not.toHaveBeenCalled();
      await catalog.patch('entries',second.id,{discoveryComplete:false});
      expect(changed).toHaveBeenLastCalledWith([second.id]);
      await catalog.put('metadata',{id:bookDownloadId(first.comicId),status:'clearing'});
      expect(changed).toHaveBeenLastCalledWith([first.id,second.id]);
    }finally{unsubscribe();}
  });
});
