import 'fake-indexeddb/auto';
import {seedComic} from './comic-fixture';
import {readFile} from 'node:fs/promises';
import {describe,expect,it,vi} from 'vitest';
import {BlobReader,BlobWriter,ZipReader} from '@zip.js/zip.js/index-native.js';
import {catalog} from '../src/comics/repositories';
import {RENDER_PROFILE} from '../src/comics/pages/identity';
import {exportManifest,MAX_EXPORT_BYTES,planExport,safeName,type ExportOptions} from '../src/export/plan';
import {writeExport} from '../src/export/files';
import {exportImage} from '../src/export/images';
import {pdfWriter} from '../src/export/pdf';
import {PDFDocument} from 'pdf-lib';
import {importContainer,releaseContainer} from '../src/storage/containers';
import {exportDocument,exportOriginalFile} from '../src/comics/application/export-service';
import type {Job} from '../src/types';
import {translationCache} from '../src/storage/translations';
import {loadResultBlob,resultBlobKey} from '../src/storage/translations/results';
import {acquirePage} from '../src/comics/pages/service';
vi.mock('../src/comics/pages/service',()=>({acquirePage:vi.fn(),materializationId:(ref:{contentId:string;pageId:string;renderProfileId:string})=>JSON.stringify([ref.contentId,ref.pageId,ref.renderProfileId])}));
const scope={key:'selected-channel'};
const options:ExportOptions={format:'cbz',images:'original',mode:'classic',language:'zh-Hans'};
const image=()=>new Blob([new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4])],{type:'image/png'});
async function sample(count=3){
  const {entry}=await seedComic({title:'导出样本',pageCount:count,discoveryComplete:true});const id=entry.id,contentId=entry.contentId;
  const pages=Array.from({length:count},(_,ordinal)=>({contentId,pageId:'page-'+ordinal,ordinal,name:String(ordinal),formatLocator:'entry:'+ordinal,locator:{entry:ordinal,url:'https://private.example/?token=secret'}}));
  await catalog.putPages(id,contentId,pages,1);return {id,contentId,pages};
}
const job=(id:string,changes:Partial<Job>={}):Job=>({id,result:{key:'private-result',recoverable:true},status:'succeeded',mode:'classic',target_language:'zh-Hans',version:1,phase:'done',quota_pages:0,cache_hit:false,created_at:'2026-09-22',...changes});
async function bind(s:Awaited<ReturnType<typeof sample>>,jobs:Job[],outputBlobs:Record<string,string>={}){
  const identity={id:JSON.stringify([s.contentId,'page-0',RENDER_PROFILE]),contentId:s.contentId,pageId:'page-0',renderProfileId:RENDER_PROFILE,imageSha256:'a'.repeat(64),byteSize:12,mime:'image/png',width:100,height:100,updatedAt:Date.now()};
  expect(await catalog.putMaterialization(identity,1)).toBe(true);
  await catalog.put('translationBindings',{id:JSON.stringify([scope.key,identity.imageSha256]),scope:scope.key,imageSha256:identity.imageSha256,payload:{translationScope:scope.key,jobs,outputBlobs},updatedAt:Date.now()});
  return identity;
}
describe('document export through page leases',()=>{
  it('uses original pixels for export and frozen translation pixels when restoring an existing overlay',async()=>{
    vi.mocked(acquirePage).mockClear();
    const s=await sample(2),result=job('restore-overlay'),identity=await bind(s,[result]);
    const original=image(),release=vi.fn();
    vi.mocked(acquirePage).mockResolvedValue({blob:original,release,identity});
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:100,height:100,close(){}})));
    try{
      const readResult=vi.fn(async(_job:Job,_signal?:AbortSignal,readOriginal?:()=>Promise<Blob|undefined>)=>{
        expect(await readOriginal!()).toBe(original);return image();
      });
      await exportDocument(s.id,{...options,images:'translation'},{scope,readResult,signal:new AbortController().signal});
      expect(acquirePage).toHaveBeenCalledWith(expect.objectContaining({pageId:'page-0',purpose:'translation'}));
      expect(acquirePage).toHaveBeenCalledWith(expect.objectContaining({pageId:'page-1',purpose:'export'}));
      expect(release).toHaveBeenCalledTimes(2);
    }finally{vi.unstubAllGlobals();}
  });
  it('exports a decoded page beyond the former 32 million pixel ceiling',async()=>{
    const close=vi.fn();vi.stubGlobal('createImageBitmap',async()=>({width:8000,height:6000,close}));
    try { const blob=image();expect(await exportImage(blob)).toMatchObject({blob,width:8000,height:6000});expect(close).toHaveBeenCalledOnce(); }
    finally { vi.unstubAllGlobals(); }
  });
  it('keeps supported archive images and PDF JPEGs without decoding or recompressing pixels',async()=>{
    const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAYAAACAcVaiAAAAFElEQVR4nGMUsYmqZoACJhiDBA4ASGUBLySXec0AAAAASUVORK5CYII=','base64')],{type:'image/png'});
    const jpeg=new Blob([await readFile(new URL('./fixtures/translation/home/color-original.jpg',import.meta.url))],{type:'image/jpeg'});
    const decode=vi.fn(()=>{throw Error('Unexpected pixel decoding');});vi.stubGlobal('createImageBitmap',decode);
    try{
      expect(await exportImage(png)).toMatchObject({blob:png,width:3,height:5});
      const image=await exportImage(jpeg,true);expect(image.blob).toBe(jpeg);expect(image.extension).toBe('jpg');
      const writer=await pdfWriter('JPEG export');await writer.add(jpeg);
      const pdf=await PDFDocument.load(await(await writer.close('{}')).arrayBuffer());
      expect(pdf.getPageCount()).toBe(1);expect(pdf.getPage(0).getWidth()/pdf.getPage(0).getHeight()).toBeCloseTo(image.width/image.height);
      expect(decode).not.toHaveBeenCalled();
    }finally{vi.unstubAllGlobals();}
  });
  it('still normalizes oriented JPEGs before embedding them in PDF',async()=>{
    const jpeg=new Blob([await readFile(new URL('./fixtures/normalization/orientation-6.jpg',import.meta.url))],{type:'image/jpeg'}),encoded=new Blob(['normalized'],{type:'image/jpeg'}),close=vi.fn();
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:200,height:100,close})));
    vi.stubGlobal('OffscreenCanvas',class {width=200;height=100;getContext(){return {fillRect(){},drawImage(){}};}async convertToBlob(){return encoded;}});
    try{expect(await exportImage(jpeg,true)).toMatchObject({blob:encoded,width:200,height:100});expect(close).toHaveBeenCalledOnce();}
    finally{vi.unstubAllGlobals();}
  });
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
    const s=await sample(1),local=job('local',{result:{key:crypto.randomUUID(),recoverable:false}});
    await bind(s,[local]);
    expect((await planExport(s.id,{...options,images:'translation'},scope)).pages[0].kind).toBe('fallback');
    await translationCache.put(resultBlobKey(scope,local),image(),{owner:scope.key});
    const plan=await planExport(s.id,{...options,images:'translation'},scope);
    expect(plan.pages[0]).toMatchObject({kind:'translation',job:{id:'local'}});
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
    await bind(s,[job('old'),job('expired',{version:2,result_expired:true})],{old:'older-cache'});
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
  it('prefetches at most two pages and writes ordered original bytes and a manifest',async()=>{
    const s=await sample(),plan=await planExport(s.id,options),progress=vi.fn(),started:number[]=[],released:number[]=[];let maximum=0;
    let first!:()=>void,second!:()=>void;
    const firstReady=new Promise<void>(resolve=>{first=resolve;}),secondStarted=new Promise<void>(resolve=>{second=resolve;});
    const images=plan.pages.map(page=>new Blob([image(),String(page.ordinal)],{type:'image/png'}));
    const pending=writeExport(plan,{assertCurrent(){},progress,async acquire(page){
      started.push(page.ordinal);maximum=Math.max(maximum,started.length-released.length);
      if(page.ordinal===0)await firstReady;if(page.ordinal===1)second();
      return {blob:images[page.ordinal],width:100,height:100,release(){released.push(page.ordinal);}};
    }},new AbortController().signal);
    await secondStarted;expect(started).toEqual([0,1]);expect(released).toEqual([]);first();
    const result=await pending;expect(maximum).toBe(2);expect(released).toEqual([0,1,2]);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({completed:3,total:3}));
    const reader=new ZipReader(new BlobReader(result.blob!));
    try{const entries=await reader.getEntries();expect(entries.map(entry=>entry.filename)).toEqual(['00001.png','00002.png','00003.png','export-manifest.json']);
      for(const [index,entry] of entries.slice(0,3).entries()){if(entry.directory)throw Error('unexpected directory');expect(await(await entry.getData(new BlobWriter())).arrayBuffer()).toEqual(await images[index].arrayBuffer());}
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
    expect(released).toHaveBeenCalledTimes(2);expect(aborted).toHaveBeenCalledOnce();expect(closed).not.toHaveBeenCalled();
  });
  it.each(['cancel','failure'])('cleans up a late prefetched lease after %s without waiting for it',async(mode)=>{
    const s=await sample(4),plan=await planExport(s.id,options),controller=new AbortController(),release=vi.fn(),lateRelease=vi.fn();
    let first!:()=>void,second!:()=>void,late!:(lease:{blob:Blob;release():void})=>void,readSignal:AbortSignal|undefined;
    const firstReady=new Promise<void>(resolve=>{first=resolve;}),secondStarted=new Promise<void>(resolve=>{second=resolve;});
    const acquire=vi.fn(async(page,signal)=>{
      if(page.ordinal===0){await firstReady;return {blob:image(),width:100,height:100,release};}
      readSignal=signal;second();return new Promise<{blob:Blob;release():void}>(resolve=>{late=resolve;});
    });
    const destination=new WritableStream<Uint8Array>({write(){if(mode==='cancel'){controller.abort();controller.signal.throwIfAborted();}throw Error('disk failed');}});
    const result=writeExport(plan,{assertCurrent(){},acquire},controller.signal,destination);
    const failed=expect(result).rejects.toThrow(mode==='cancel'?/abort/i:'disk failed');
    await secondStarted;first();await failed;
    expect(readSignal?.aborted).toBe(true);expect(acquire).toHaveBeenCalledTimes(2);expect(release).toHaveBeenCalledOnce();expect(destination.locked).toBe(false);
    late({blob:image(),release:lateRelease});await vi.waitFor(()=>expect(lateRelease).toHaveBeenCalledOnce());
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
