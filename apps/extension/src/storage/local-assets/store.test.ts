import 'fake-indexeddb/auto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Sha256} from '../../importers/hash';
import {assetLock,assetRecord,downloadAsset,readAsset,removeAsset,type LocalAsset} from './store';
const held=new Set<string>();
beforeEach(()=>{held.clear();vi.stubGlobal('navigator',{storage:{estimate:async()=>({quota:1024**3,usage:0})},locks:{request:async(name:string,options:unknown,callback?:(value:unknown)=>Promise<unknown>)=>{
  const run=typeof options==='function'?options:callback!;
  if(held.has(name))return run(null);held.add(name);try{return await run({name});}finally{held.delete(name);}
}}});});
const descriptor=(bytes:Uint8Array):LocalAsset=>({id:crypto.randomUUID(),url:'https://assets.example/model',bytes:bytes.length,sha256:new Sha256().update(bytes).digest(),license:'test',source:'https://example.com',label:'fixture'});
describe('streamed local asset storage',()=>{
  it('resumes only committed chunks and verifies the complete stored bytes',async()=>{
    const bytes=new Uint8Array(1024*1024+4);bytes.fill(7);const asset=descriptor(bytes);let pull=0;
    const broken=new ReadableStream<Uint8Array>({pull(controller){if(pull++===0)controller.enqueue(bytes.slice(0,1024*1024));else controller.error(Error('offline'));}});
    await expect(downloadAsset(asset,new AbortController().signal,()=>{},vi.fn().mockResolvedValue(new Response(broken,{headers:{ETag:'"one"'}})))).rejects.toThrow();
    expect((await assetRecord(asset))?.offset).toBe(1024*1024);
    const fetcher=vi.fn().mockResolvedValue(new Response(bytes.slice(1024*1024),{status:206,headers:{'Content-Range':`bytes 1048576-1048579/${bytes.length}`,ETag:'"one"'}}));
    await downloadAsset(asset,new AbortController().signal,()=>{},fetcher);
    expect(fetcher.mock.calls[0][1].headers).toEqual({Range:'bytes=1048576-','If-Range':'"one"'});
    expect((await assetRecord(asset))?.state).toBe('ready');expect(new Uint8Array(await (await readAsset(asset)).arrayBuffer())).toEqual(bytes);
  });
  it('rejects corrupt bytes and never publishes them as installed',async()=>{
    const bytes=new Uint8Array([1,2,3]),asset=descriptor(bytes);
    await expect(downloadAsset(asset,new AbortController().signal,()=>{},vi.fn().mockResolvedValue(new Response(new Uint8Array([4,5,6]))))).rejects.toThrow('ASSET_CORRUPT');
    expect(await assetRecord(asset)).toMatchObject({state:'error',offset:0});await expect(readAsset(asset)).rejects.toThrow('ASSET_MISSING');
  });
  it('does not remove resources leased by an inference session',async()=>{
    const asset=descriptor(new Uint8Array([9]));held.add(assetLock(asset));await expect(removeAsset(asset)).rejects.toThrow('ASSET_BUSY');
  });
  it('makes insufficient space visible without issuing a network request',async()=>{
    Object.assign(navigator.storage,{estimate:async()=>({quota:1,usage:0})});
    const asset=descriptor(new Uint8Array([8])),fetcher=vi.fn();
    await expect(downloadAsset(asset,new AbortController().signal,()=>{},fetcher)).rejects.toThrow('ASSET_STORAGE_FULL');
    expect(await assetRecord(asset)).toMatchObject({state:'error',error:'ASSET_STORAGE_FULL'});expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not accept a range response for different bytes',async()=>{
    const asset=descriptor(new Uint8Array([3,9,7]));
    const fetcher=vi.fn().mockResolvedValue(new Response(new Uint8Array([3,9,7]),{status:206,headers:{'Content-Range':'bytes 1-3/4'}}));
    await expect(downloadAsset(asset,new AbortController().signal,()=>{},fetcher)).rejects.toThrow('ASSET_RANGE_INVALID');
    expect(await assetRecord(asset)).toMatchObject({state:'error',offset:0});
  });
});
