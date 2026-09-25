import 'fake-indexeddb/auto';
import {seedComic} from './comic-fixture';
import {describe,expect,it,vi} from 'vitest';
import {BlobReader,BlobWriter,ZipReader} from '@zip.js/zip.js/index-native.js';
import {catalog} from '../src/comics/repositories';
import {RENDER_PROFILE} from '../src/comics/pages/identity';
import {exportManifest,MAX_EXPORT_BYTES,planExport,safeName,type ExportOptions} from '../src/export/plan';
import {writeExport} from '../src/export/files';
import {importContainer,releaseContainer} from '../src/storage/containers';
import {exportDocument,exportOriginalFile} from '../src/comics/application/export-service';
import type {Job} from '../src/types';
import {translationCache} from '../src/storage/translations';
import {loadResultBlob,resultBlobKey} from '../src/storage/translations/results';
vi.mock('../src/comics/pages/service',()=>({acquirePage:vi.fn(),materializationId:(ref:{contentId:string;pageId:string;renderProfileId:string})=>JSON.stringify([ref.contentId,ref.pageId,ref.renderProfileId])}));
const scope={key:'selected-channel'};
const options:ExportOptions={format:'cbz',images:'original',mode:'classic',language:'zh-Hans'};
const image=()=>new Blob([new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4])],{type:'image/png'});
async function sample(count=3){
  const {entry}=await seedComic({title:'导出样本',pageCount:count,discoveryComplete:true});const id=entry.id,contentId=entry.contentId;
  const pages=Array.from({length:count},(_,ordinal)=>({contentId,pageId:'page-'+ordinal,ordinal,name:String(ordinal),formatLocator:'entry:'+ordinal,locator:{entry:ordinal,url:'https://private.example/?token=secret'}}));
  await catalog.putPages(id,contentId,pages,1);return {id,contentId,pages};
}
const job=(id:string,changes:Partial<Job>={}):Job=>({id,input_asset_id:'input',output_asset_id:'private-result',result:{key:'private-result',recoverable:true},status:'succeeded',mode:'classic',target_language:'zh-Hans',version:1,phase:'done',quota_pages:0,cache_hit:false,created_at:'2026-09-22',...changes});
async function bind(s:Awaited<ReturnType<typeof sample>>,jobs:Job[],outputBlobs:Record<string,string>={}){
  const identity={id:JSON.stringify([s.contentId,'page-0',RENDER_PROFILE]),contentId:s.contentId,pageId:'page-0',renderProfileId:RENDER_PROFILE,imageSha256:'a'.repeat(64),byteSize:12,mime:'image/png',width:100,height:100,updatedAt:Date.now()};
  expect(await catalog.putMaterialization(identity,1)).toBe(true);
  await catalog.put('translationBindings',{id:JSON.stringify([scope.key,identity.imageSha256]),scope:scope.key,imageSha256:identity.imageSha256,payload:{translationScope:scope.key,jobs,outputBlobs},updatedAt:Date.now()});
}
describe('document export through page leases',()=>{
  it('exports through the injected channel reader and reuses existing result bytes without network access',async()=>{
    const s=await sample(1),result=job('export-cached');await bind(s,[result]);
    await translationCache.put(resultBlobKey(scope,result),image(),{owner:scope.key});
    const download=vi.fn(async()=>{throw Error('unexpected network');}),readResult=vi.fn((job:Job)=>loadResultBlob({scope,job,download,isCurrent:()=>true}));
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:100,height:100,close(){}})));
    try{const exported=await exportDocument(s.id,{...options,images:'translation'},{scope,readResult,isCurrent:()=>true,signal:new AbortController().signal});
      expect(exported.blob).toBeInstanceOf(Blob);expect(readResult).toHaveBeenCalledOnce();expect(download).not.toHaveBeenCalled();
    }finally{vi.unstubAllGlobals();}
  });
  it('exports only cached local results without account identities or remote assets',async()=>{
    const s=await sample(1),local=job('local',{output_asset_id:null,result:{key:crypto.randomUUID(),recoverable:false}});
    await bind(s,[local]);
    expect((await planExport(s.id,{...options,images:'translation'},scope)).pages[0].kind).toBe('fallback');
    await translationCache.put(resultBlobKey(scope,local),image(),{owner:scope.key});
    const plan=await planExport(s.id,{...options,images:'translation'},scope);
    expect(plan.pages[0]).toMatchObject({kind:'translation',job:{id:'local',output_asset_id:null}});
    await translationCache.delete(resultBlobKey(scope,local));
    expect((await planExport(s.id,{...options,images:'translation'},scope)).pages[0].kind).toBe('fallback');
  });
  it('plans source descriptors without reading image bytes and keeps a frozen revision',async()=>{
    const sampleData=await sample(105),plan=await planExport(sampleData.id,options);
    expect(plan.pages).toHaveLength(105);expect(plan.pages.map(page=>page.ordinal)).toEqual(Array.from({length:105},(_,i)=>i));
    expect(plan.contentId).toBe(sampleData.contentId);expect(plan.pages.every(page=>page.kind==='original')).toBe(true);
  });
  it('only uses the selected account’s latest delivered translation; missing pages remain explicit original fallbacks',async()=>{
    const s=await sample();await bind(s,[job('older'),job('latest',{version:2}),job('running',{version:3,status:'running'})],{latest:'result-cache-key'});
    const plan=await planExport(s.id,{...options,images:'translation'},scope);
    expect(plan.pages.map(page=>page.kind)).toEqual(['translation','fallback','fallback']);expect(plan.pages[0].job?.id).toBe('latest');
    const other=await planExport(s.id,{...options,images:'translation'},{key:'other-channel'});
    expect(other.pages.every(page=>page.kind==='fallback')).toBe(true);
    await bind(s,[job('old'),job('expired',{version:2,output_asset_id:null,result_expired:true})],{old:'older-cache'});
    expect((await planExport(s.id,{...options,images:'translation'},scope)).pages[0].kind).toBe('fallback');
  });
  it('requires explicit partial export and emits a credential-free manifest',async()=>{
    const s=await sample();await catalog.patch('entries',s.id,{discoveryComplete:false,knownTotal:8});
    await expect(planExport(s.id,options)).rejects.toThrow('尚未全部发现');
    await bind(s,[job('translated')]);
    const plan=await planExport(s.id,{...options,allowIncomplete:true,images:'translation'},scope);
    const manifest=JSON.stringify(exportManifest(plan));expect(JSON.parse(manifest).complete).toBe(false);
    for(const secret of ['private.example','token','secret','alice','api.example','private-result','sourceUrl','cacheKey'])expect(manifest).not.toContain(secret);
  });
  it('writes a real archive incrementally with at most one live page lease and includes its manifest',async()=>{
    const s=await sample(),plan=await planExport(s.id,options);let active=0,maximum=0,released=0;
    const result=await writeExport(plan,{assertCurrent(){},async acquire(){active++;maximum=Math.max(maximum,active);return {blob:image(),width:100,height:100,release(){active--;released++;}};}},new AbortController().signal);
    expect(maximum).toBe(1);expect(released).toBe(3);expect(result.blob).toBeDefined();
    const reader=new ZipReader(new BlobReader(result.blob!));
    try{const entries=await reader.getEntries();expect(entries.map(entry=>entry.filename)).toEqual(['00001.png','00002.png','00003.png','export-manifest.json']);
      const entry=entries[0];if(entry.directory)throw Error('unexpected directory');expect(await(await entry.getData(new BlobWriter())).arrayBuffer()).toEqual(await image().arrayBuffer());
    }finally{await reader.close();}
  });
  it('streams directly to a supplied file destination without returning an in-memory archive',async()=>{
    const s=await sample(),plan=await planExport(s.id,options);let bytes=0,closed=false;
    const stream=new WritableStream<Uint8Array>({write(chunk){bytes+=chunk.length;},close(){closed=true;}});
    const result=await writeExport(plan,{assertCurrent(){},async acquire(){return {blob:image(),width:100,height:100,release(){}};}},new AbortController().signal,stream);
    expect(result.blob).toBeUndefined();expect(result.bytes).toBe(bytes);expect(closed).toBe(true);
  });
  it('aborts the file and releases the active page when account/revision validation changes mid-read',async()=>{
    const s=await sample(),plan=await planExport(s.id,options);let current=true;const released=vi.fn(),aborted=vi.fn(),closed=vi.fn();
    const stream=new WritableStream<Uint8Array>({write(){},close:closed,abort:aborted});
    await expect(writeExport(plan,{assertCurrent(){if(!current)throw Error('账户已变化');},async acquire(){current=false;return {blob:image(),release:released};}},new AbortController().signal,stream)).rejects.toThrow('账户已变化');
    expect(released).toHaveBeenCalledOnce();expect(aborted).toHaveBeenCalledOnce();expect(closed).not.toHaveBeenCalled();
  });
  it('enforces the 128 MiB fallback ceiling before copying the large page into output',async()=>{
    const s=await sample(1),plan=await planExport(s.id,options),blob=image(),release=vi.fn();Object.defineProperty(blob,'size',{value:MAX_EXPORT_BYTES+1});
    await expect(writeExport(plan,{assertCurrent(){},async acquire(){return {blob,release};}},new AbortController().signal)).rejects.toThrow('128 MiB');expect(release).toHaveBeenCalledOnce();
  });
  it('exports saved source bytes exactly without invoking a parser',async()=>{
    const s=await sample(1),input=new File([new Uint8Array([80,75,3,4,7,8,9,10])],'source.cbz');
    const container=await importContainer(input,undefined,undefined,s.contentId);await catalog.patch('entries',s.id,{containerId:container.id});
    try{const result=await exportOriginalFile(s.id,{signal:new AbortController().signal});expect(result.name).toBe('导出样本.cbz');expect(await result.blob!.arrayBuffer()).toEqual(await input.arrayBuffer());}
    finally{await releaseContainer(container.id,s.contentId);}
  });
  it('sanitizes filenames without traversal or reserved Windows device names',()=>{
    for(const name of ['../..\\目录:标题?*','CON','LPT1.txt','..','\u0000\u202eabc'])expect(safeName(name)).not.toMatch(/[\\/:?*\u0000\u202e]|^[. ]|[. ]$/);
    expect(safeName('CON')).toBe('_CON');
  });
});
