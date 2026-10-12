import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Page, Job} from '../src/types';
const mocks = vi.hoisted(() => ({acquire:vi.fn(), prepare:vi.fn(), enhance:vi.fn()}));
vi.mock('../src/comics/application/image-access', () => ({acquireImage:mocks.acquire,
  processingInput:(key:string,owner:string)=>({key,owner,validate:async()=>{},load:(signal:AbortSignal)=>mocks.acquire(key,signal)})}));
vi.mock('../src/reader/prepare-image', () => ({prepareReaderImage:mocks.prepare}));
vi.mock('../src/image-processing/runtime', () => ({enhanceImage:mocks.enhance}));
import {EpubImageWindow} from '../src/reader/epub-images';
import {epubImageId} from '../src/comics/domain/epub-images';

let intersect: (entries: {target:Element;isIntersecting:boolean;intersectionRect:{width:number;height:number}}[]) => void;
let revoke: ReturnType<typeof vi.fn<(url: string) => void>>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) {intersect=callback;}
    observe() {} unobserve() {} disconnect() {}
  });
  let id = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:translated-' + ++id);
  revoke = vi.fn(); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
  mocks.acquire.mockImplementation(async () => ({blob:new Blob(['pixels']),release:vi.fn()}));
  mocks.prepare.mockResolvedValue(undefined);
  mocks.enhance.mockImplementation(async(input,_profile,signal,options)=>{
    const lease=await input.load(signal);try{await options.onParent?.(lease.blob);return new Blob(['enhanced']);}finally{lease.release();}
  });
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

function artwork(hrefs = Array.from({length:6},(_,i)=>`OPS/${i}.png`)) {
  const text = 'Body and captions remain original';
  const document = {textContent:text, querySelectorAll:() => images,addEventListener:vi.fn(),removeEventListener:vi.fn()} as unknown as Document;
  const images = hrefs.map((href, i) => {
    const attrs = new Map<string, Attr>();
    const element = {localName:'img',ownerDocument:document,complete:true,naturalWidth:240,naturalHeight:360,
      get attributes() {return [...attrs.values()];},getAttribute:(key:string)=>attrs.get(key)?.value??null,removeAttribute:(key:string)=>attrs.delete(key),
      setAttribute(key:string,value:string) {this.setAttributeNS(null,key,value);},
      setAttributeNS(_namespace:string|null,key:string,value:string) {const attr=attrs.get(key);if(attr)attr.value=value;else attrs.set(key,{name:key,localName:key,value,namespaceURI:null} as Attr);},
    };
    element.setAttribute('src',`blob:original-${i}`); element.setAttribute('data-nc-epub-image',href);
    return element as unknown as HTMLImageElement;
  });
  return {document,images};
}
function page(href:string):Page {
  const job:Job={id:href,mode:'classic',target_language:'en',status:'succeeded',phase:'done',quota_pages:0,created_at:'2026-01-01',version:1,cache_hit:false,result:{key:href,recoverable:true}};
  return {id:epubImageId(href),name:href,width:240,height:360,blobKey:'source:'+href,jobs:[job],outputBlobs:{[job.id]:'result:'+href},translationScope:'account-a'};
}
function visible(images:Element[],at:number) {intersect(images.map((target,i)=>({target,isIntersecting:i===at,intersectionRect:{width:i===at?240:0,height:i===at?360:0}})));}

describe('EPUB embedded image window', () => {
  const processing = () => ({owner:'entry-a',settings:{enabled:true,activeId:'local',cacheLimitMb:512,
    profiles:[{id:'local',adapterId:'nunif',revision:1,name:'Local',settings:{url:'http://localhost/'}}]}});
  it('enhances unchanged originals after no-text completion and restores them when disabled',async()=>{
    const {document,images}=artwork(),window=new EpubImageWindow(vi.fn(),vi.fn());window.add(document);visible(images,0);
    const pages=images.map(image=>{
      const value=page(image.getAttribute('data-nc-epub-image')!);
      return {...value,outputBlobs:{},jobs:value.jobs.map(job=>({...job,status:'no_text' as const,
        delivery:{kind:'no_text' as const,representation:'original' as const,normalization_version:1 as const,input_sha256:'a'.repeat(64),width:240,height:360}}))};
    });
    window.show(pages,true,'classic','en','account-a',processing());
    await vi.waitFor(()=>expect(window.enhancementState('OPS/0.png')?.phase).toBe('ready'));
    expect(mocks.enhance.mock.calls.map(([input])=>input.key)).toEqual(['source:OPS/0.png','source:OPS/1.png']);
    expect(images[0].getAttribute('src')).toMatch(/^blob:translated/);
    expect(images[0].getAttribute('width')).toBe('240');expect(images[0].getAttribute('height')).toBe('360');
    window.show(pages,true,'classic','en','account-a',{...processing(),settings:{...processing().settings,enabled:false}});
    expect(images[0].getAttribute('src')).toBe('blob:original-0');expect(mocks.enhance).toHaveBeenCalledTimes(2);window.close();
  });
  it('displays a warm enhancement without reading a parent or waiting for the original element to load',async()=>{
    mocks.enhance.mockResolvedValue(new Blob(['cached enhancement']));mocks.acquire.mockRejectedValue(Error('Parent unavailable'));
    const {document,images}=artwork(['OPS/0.png']),window=new EpubImageWindow(vi.fn(),vi.fn());
    Object.assign(images[0],{complete:false,naturalWidth:0,naturalHeight:0});
    window.add(document);visible(images,0);window.show([page('OPS/0.png')],true,'classic','en','account-a',processing());
    await vi.waitFor(()=>expect(window.enhancementState('OPS/0.png')?.phase).toBe('ready'));
    expect(images[0].getAttribute('src')).toMatch(/^blob:translated/);
    expect(images[0].getAttribute('width')).toBe('240');expect(images[0].getAttribute('height')).toBe('360');
    expect(mocks.acquire).not.toHaveBeenCalled();expect(mocks.prepare).toHaveBeenCalledOnce();window.close();
  });
  it('enhances only complete translations in a two-image window and preserves the author box', async () => {
    const {document,images}=artwork(),window=new EpubImageWindow(vi.fn(),vi.fn());window.add(document);visible(images,0);
    const pages=images.map(image=>page(image.getAttribute('data-nc-epub-image')!));
    window.show(pages.map(page=>({...page,outputBlobs:{}})),true,'classic','en','account-a',processing());
    expect(mocks.enhance).not.toHaveBeenCalled();
    window.show(pages,true,'classic','en','account-a',processing());
    await vi.waitFor(()=>expect(mocks.enhance).toHaveBeenCalledTimes(2));
    expect(mocks.enhance.mock.calls.map(([input])=>input.key)).toEqual(['result:OPS/0.png','result:OPS/1.png']);
    await vi.waitFor(()=>expect(images[0].getAttribute('width')).toBe('240'));expect(images[0].getAttribute('height')).toBe('360');
    window.show(pages,true,'classic','en','account-a',{...processing(),settings:{...processing().settings,enabled:false}});
    await vi.waitFor(()=>expect(images[0].getAttribute('src')).not.toBe('blob:original-0'));
    expect(mocks.enhance).toHaveBeenCalledTimes(2);window.close();
  });
  it('keeps a full translation on enhancement failure and explicitly retries enhancement only', async () => {
    mocks.enhance.mockImplementationOnce(async(input,_profile,signal,options)=>{
      const lease=await input.load(signal);try{await options.onParent(lease.blob);throw Error('Enhancement failed');}finally{lease.release();}
    });
    const errors=vi.fn(),{document,images}=artwork(['OPS/0.png']),window=new EpubImageWindow(vi.fn(),errors);window.add(document);visible(images,0);
    window.show([page('OPS/0.png')],true,'classic','en','account-a',processing());
    await vi.waitFor(()=>expect(window.enhancementState('OPS/0.png')).toEqual({phase:'error',message:'Enhancement failed'}));
    expect(errors).not.toHaveBeenCalledWith('OPS/0.png','Enhancement failed');
    const base=images[0].getAttribute('src');expect(base).toMatch(/^blob:translated/);
    window.retry('OPS/0.png');
    await vi.waitFor(()=>expect(mocks.enhance).toHaveBeenCalledTimes(2));
    expect(mocks.enhance.mock.lastCall?.[3].retry).toBe(true);
    await vi.waitFor(()=>expect(images[0].getAttribute('src')).not.toBe(base));window.close();
  });
  it('exposes original-image enhancement progress and an independent retryable error', async () => {
    const pending=Promise.withResolvers<Blob>();
    mocks.enhance.mockImplementationOnce((_input,_profile,_signal,options) => {options.onState({phase:'running'});return pending.promise;});
    const changed=vi.fn(),errors=vi.fn(),{document,images}=artwork(['OPS/0.png']);
    const window=new EpubImageWindow(vi.fn(),errors,changed);window.add(document);visible(images,0);
    window.show([page('OPS/0.png')],false,'classic','en','account-a',processing());
    await vi.waitFor(()=>expect(window.enhancementState('OPS/0.png')?.phase).toBe('running'));
    expect(mocks.enhance.mock.calls[0][0].key).toBe('source:OPS/0.png');
    const base=images[0].getAttribute('src');
    pending.reject(Error('Enhancement unavailable'));
    await vi.waitFor(()=>expect(window.enhancementState('OPS/0.png')).toEqual({phase:'error',message:'Enhancement unavailable'}));
    expect(images[0].getAttribute('src')).toBe(base);
    expect(errors).not.toHaveBeenCalledWith('OPS/0.png','Enhancement unavailable');
    window.retry('OPS/0.png');
    await vi.waitFor(()=>expect(window.enhancementState('OPS/0.png')?.phase).toBe('ready'));
    expect(mocks.enhance.mock.lastCall?.[3].retry).toBe(true);
    expect(changed).toHaveBeenCalled();window.close();
  });
  it('retains a prefetched enhancement failure when its artwork becomes the current image', async () => {
    let failed=false;
    mocks.enhance.mockImplementation(async input => {
      if(input.key==='result:OPS/1.png'&&!failed){failed=true;throw Error('Prefetch failed');}
      return new Blob(['enhanced']);
    });
    const changed=vi.fn(),{document,images}=artwork(),window=new EpubImageWindow(changed,vi.fn());
    const pages=images.map(image=>page(image.getAttribute('data-nc-epub-image')!));
    window.add(document);visible(images,0);window.show(pages,true,'classic','en','account-a',processing());
    await vi.waitFor(()=>expect(window.enhancementState('OPS/1.png')?.phase).toBe('error'));
    visible(images,1);
    // Reapplying refreshed page metadata must not clear the retained processing state.
    window.show(pages.map(page=>({...page})),true,'classic','en','account-a',processing());
    expect(changed).toHaveBeenLastCalledWith(['OPS/1.png','OPS/2.png','OPS/3.png','OPS/4.png']);
    expect(window.enhancementState('OPS/1.png')).toEqual({phase:'error',message:'Prefetch failed'});
    expect(mocks.enhance.mock.calls.filter(([input])=>input.key==='result:OPS/1.png')).toHaveLength(1);
    window.retry('OPS/1.png');
    await vi.waitFor(()=>expect(window.enhancementState('OPS/1.png')?.phase).toBe('ready'));
    expect(mocks.enhance.mock.calls.filter(([input])=>input.key==='result:OPS/1.png')).toHaveLength(2);window.close();
  });
  it('reports an original parent-image read failure through enhancement status and retries the read', async () => {
    mocks.acquire.mockRejectedValueOnce(Error('Parent image unavailable'));
    const errors=vi.fn(),{document,images}=artwork(['OPS/0.png']),window=new EpubImageWindow(vi.fn(),errors);
    window.add(document);visible(images,0);window.show([page('OPS/0.png')],false,'classic','en','account-a',processing());
    await vi.waitFor(()=>expect(window.enhancementState('OPS/0.png')).toEqual({phase:'error',message:'Parent image unavailable'}));
    expect(images[0].getAttribute('src')).toBe('blob:original-0');
    expect(errors).not.toHaveBeenCalledWith('OPS/0.png','Parent image unavailable');
    expect(mocks.enhance).toHaveBeenCalledOnce();
    window.retry('OPS/0.png');
    await vi.waitFor(()=>expect(window.enhancementState('OPS/0.png')?.phase).toBe('ready'));
    expect(mocks.acquire).toHaveBeenCalledTimes(2);expect(mocks.enhance).toHaveBeenCalledTimes(2);window.close();
  });
  it('does not reload the displayed enhancement when only its name or cache budget changes', async () => {
    const {document,images}=artwork(['OPS/0.png']),window=new EpubImageWindow(vi.fn(),vi.fn());
    const pages=[page('OPS/0.png')],config=processing();
    window.add(document);visible(images,0);window.show(pages,true,'classic','en','account-a',config);
    await vi.waitFor(()=>expect(window.enhancementState('OPS/0.png')?.phase).toBe('ready'));
    const displayed=images[0].getAttribute('src'),reads=mocks.acquire.mock.calls.length;
    window.show(pages,true,'classic','en','account-a',{...config,settings:{...config.settings,cacheLimitMb:128,
      profiles:config.settings.profiles.map(profile=>({...profile,name:'Renamed'}))}});
    expect(images[0].getAttribute('src')).toBe(displayed);
    expect(mocks.acquire).toHaveBeenCalledTimes(reads);expect(mocks.enhance).toHaveBeenCalledOnce();window.close();
  });
  it('starts at visible artwork, bounds translation to four unique assets, and never translates off-screen-only chapters', () => {
    const changed=vi.fn(),{document,images}=artwork();const window=new EpubImageWindow(changed,vi.fn());window.add(document);
    expect(changed).not.toHaveBeenCalled();expect(mocks.acquire).not.toHaveBeenCalled();
    visible(images,1);expect(changed).toHaveBeenLastCalledWith(['OPS/1.png','OPS/2.png','OPS/3.png','OPS/4.png']);
    visible(images,-1);expect(changed).toHaveBeenLastCalledWith([]);window.close();
  });

  it('replaces image resources without changing text or intrinsic layout and restores originals on switch', async () => {
    const {document,images}=artwork(),window=new EpubImageWindow(vi.fn(),vi.fn());window.add(document);visible(images,0);
    window.show(images.map(image=>page(image.getAttribute('data-nc-epub-image')!)),true,'classic','en','account-a');
    await vi.waitFor(()=>expect(images[0].getAttribute('src')).toBe('blob:translated-1'));
    expect(mocks.acquire).toHaveBeenCalledTimes(4);
    const leases=await Promise.all(mocks.acquire.mock.results.map(result=>result.value));
    for(const lease of leases)expect(lease.release).toHaveBeenCalledOnce();
    expect(images[0].getAttribute('width')).toBe('240');expect(images[0].getAttribute('height')).toBe('360');
    expect(document.textContent).toBe('Body and captions remain original');expect(images[4].getAttribute('src')).toBe('blob:original-4');
    window.show([],false,'classic','en','account-a');
    expect(images[0].getAttribute('src')).toBe('blob:original-0');expect(images[0].getAttribute('width')).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(4);expect(revoke.mock.calls.every(([url])=>url.startsWith('blob:translated'))).toBe(true);window.close();
    for(const lease of leases)expect(lease.release).toHaveBeenCalledOnce();
  });

  it('does not let delayed results cross an account/language change or disposed chapter', async () => {
    const ready=Promise.withResolvers<void>();mocks.prepare.mockReturnValue(ready.promise);
    const {document,images}=artwork(['OPS/0.png']),window=new EpubImageWindow(vi.fn(),vi.fn());window.add(document);visible(images,0);
    window.show([page('OPS/0.png')],true,'classic','en','account-a');
    await vi.waitFor(()=>expect(mocks.prepare).toHaveBeenCalledOnce());
    window.show([page('OPS/0.png')],true,'classic','en','account-b');ready.resolve();
    await vi.waitFor(()=>expect(revoke).toHaveBeenCalledWith('blob:translated-1'));
    expect((await mocks.acquire.mock.results[0].value).release).toHaveBeenCalledOnce();
    expect(images[0].getAttribute('src')).toBe('blob:original-0');
    window.show([page('OPS/0.png')],true,'classic','fr','account-a');expect(mocks.acquire).toHaveBeenCalledOnce();window.close();
  });

  it('keeps one image failure independent, retries it, and releases an unloaded chapter', async () => {
    mocks.acquire.mockRejectedValueOnce(new Error('One image failed'));
    const changed=vi.fn(),errors=vi.fn(),{document,images}=artwork(),window=new EpubImageWindow(changed,errors);window.add(document);visible(images,0);
    window.show(images.map(image=>page(image.getAttribute('data-nc-epub-image')!)),true,'classic','en','account-a');
    await vi.waitFor(()=>expect(images[1].getAttribute('src')).toMatch(/^blob:translated/));
    expect(images[0].getAttribute('src')).toBe('blob:original-0');expect(errors).toHaveBeenCalledWith('OPS/0.png','One image failed');
    window.retry('OPS/0.png');await vi.waitFor(()=>expect(images[0].getAttribute('src')).toMatch(/^blob:translated/));
    window.remove(document);expect(changed).toHaveBeenLastCalledWith([]);
    expect(images[0].getAttribute('src')).toBe('blob:original-0');expect(revoke).toHaveBeenCalledTimes(4);window.close();
  });

  it('keeps adjacent documents in spine order when scrolling backwards and limits the combined window', () => {
    const changed = vi.fn(), window = new EpubImageWindow(changed, vi.fn());
    const next = artwork(['OPS/3.png', 'OPS/4.png', 'OPS/5.png']);
    const previous = artwork(['OPS/0.png', 'OPS/1.png', 'OPS/2.png']);
    window.add(next.document, 2); visible(next.images, 0);
    window.add(previous.document, 1); visible(previous.images, 1);
    expect(changed).toHaveBeenLastCalledWith(['OPS/1.png', 'OPS/2.png', 'OPS/3.png', 'OPS/4.png']);
    window.remove(previous.document);
    expect(changed).toHaveBeenLastCalledWith(['OPS/3.png', 'OPS/4.png', 'OPS/5.png']);
    window.close();
  });
});
