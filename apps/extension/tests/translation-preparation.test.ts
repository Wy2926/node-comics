import 'fake-indexeddb/auto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {InlineOriginals} from '../src/inline/originals';
import {sourcePageCache} from '../src/storage/source-pages';
import {prepareTranslationInput} from '../src/translation/input/prepare';
import {imageWork} from '../src/translation/input/work';
import {hashFile} from '../src/importers/hash';
import {target} from './translation-fixture';
import {jpegWithSize,pngWithSize} from './image-encoding-fixture';

const workerFactory=vi.hoisted(()=>vi.fn());
vi.mock('../src/translation/input/resize.worker?worker',()=>({default:class {constructor(){return workerFactory();}}}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const unidentified=()=>({...target(0).page,imageSha256:undefined,imageByteSize:undefined});

describe('independent translation input preparation',()=>{
  it('recovers an evicted inline original through the same pixel queue without nesting the queue',async()=>{
    vi.spyOn(sourcePageCache,'get').mockResolvedValue(undefined);
    vi.spyOn(sourcePageCache,'put').mockResolvedValue(false);
    const source=jpegWithSize(800,1200,2*1024*1024),output=pngWithSize(800,1200);
    vi.stubGlobal('Worker',undefined);
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:800,height:1200,close(){}})));
    vi.stubGlobal('OffscreenCanvas',class {getContext(){return {drawImage(){}};}async convertToBlob(){return output;}});
    const originals=new InlineOriginals('preparation-test',0),restore=vi.fn(()=>imageWork(async()=>source));
    await originals.remember('page',source,restore);
    const page={...target(0).page,imageSha256:await hashFile(source),imageByteSize:source.size,imageMime:source.type};
    const prepared=await prepareTranslationInput(page,()=>originals.read('page'),()=>true);
    expect(restore).toHaveBeenCalledOnce();expect(prepared.blob).toBe(output);
    expect(prepared.image.sha256).toBe(await hashFile(output));
    expect(await imageWork(async()=>'next result')).toBe('next result');originals.clear();
  });

  it('does not hold the pixel queue while a source is slow, and cancellation releases its caller',async()=>{
    const source=Promise.withResolvers<Blob>(),controller=new AbortController(),read=vi.fn(()=>source.promise);
    const pending=prepareTranslationInput(unidentified(),read,()=>true,undefined,true,controller.signal);
    const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});
    expect(await imageWork(async()=>'ready neighbour')).toBe('ready neighbour');
    controller.abort();await rejected;
    source.resolve(pngWithSize(800,1200));
    expect(await imageWork(async()=>'later result')).toBe('later result');
  });

  it('cancels a queued preparation without starting its decoder or waiting for active pixel work',async()=>{
    const held=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();
    const first=imageWork(async()=>{started.resolve();await held.promise;});await started.promise;
    const controller=new AbortController(),decode=vi.fn();vi.stubGlobal('createImageBitmap',decode);
    const pending=prepareTranslationInput(unidentified(),async()=>pngWithSize(800,1200),()=>true,undefined,true,controller.signal);
    const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});
    for(let i=0;i<10;i++)await Promise.resolve();
    controller.abort();await rejected;
    held.resolve();await first;await imageWork(async()=>{});
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(['cancel','failure'])('terminates active resize work on %s and releases the next pixel task',async reason=>{
    const worker={onmessage:undefined as unknown,onerror:()=>{},postMessage:vi.fn(),terminate:vi.fn()};
    workerFactory.mockReturnValue(worker);vi.stubGlobal('Worker',class {});
    const source=pngWithSize(2400,3600),controller=new AbortController();
    const page={...target(0).page,width:2400,height:3600,imageSha256:await hashFile(source),imageByteSize:source.size};
    const pending=prepareTranslationInput(page,async()=>source,()=>!controller.signal.aborted,undefined,true,controller.signal);
    const rejected=reason==='cancel'?expect(pending).rejects.toMatchObject({name:'AbortError'}):expect(pending).rejects.toThrow('无法解码');
    await vi.waitFor(()=>expect(worker.postMessage).toHaveBeenCalledOnce());
    const next=imageWork(async()=>'following page');
    if(reason==='cancel')controller.abort();else worker.onerror();
    await rejected;expect(worker.terminate).toHaveBeenCalledOnce();expect(await next).toBe('following page');
  });
});
