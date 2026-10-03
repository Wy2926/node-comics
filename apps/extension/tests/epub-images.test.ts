import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Page, Job} from '../src/types';
const mocks = vi.hoisted(() => ({acquire:vi.fn(), prepare:vi.fn()}));
vi.mock('../src/comics/application/image-access', () => ({acquireImage:mocks.acquire}));
vi.mock('../src/reader/prepare-image', () => ({prepareReaderImage:mocks.prepare}));
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
    expect(images[0].getAttribute('width')).toBe('240');expect(images[0].getAttribute('height')).toBe('360');
    expect(document.textContent).toBe('Body and captions remain original');expect(images[4].getAttribute('src')).toBe('blob:original-4');
    window.show([],false,'classic','en','account-a');
    expect(images[0].getAttribute('src')).toBe('blob:original-0');expect(images[0].getAttribute('width')).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(4);expect(revoke.mock.calls.every(([url])=>url.startsWith('blob:translated'))).toBe(true);window.close();
  });

  it('does not let delayed results cross an account/language change or disposed chapter', async () => {
    const ready=Promise.withResolvers<void>();mocks.prepare.mockReturnValue(ready.promise);
    const {document,images}=artwork(['OPS/0.png']),window=new EpubImageWindow(vi.fn(),vi.fn());window.add(document);visible(images,0);
    window.show([page('OPS/0.png')],true,'classic','en','account-a');
    await vi.waitFor(()=>expect(mocks.prepare).toHaveBeenCalledOnce());
    window.show([page('OPS/0.png')],true,'classic','en','account-b');ready.resolve();
    await vi.waitFor(()=>expect(revoke).toHaveBeenCalledWith('blob:translated-1'));
    expect(images[0].getAttribute('src')).toBe('blob:original-0');
    window.show([page('OPS/0.png')],true,'classic','fr','account-a');expect(mocks.acquire).toHaveBeenCalledOnce();window.close();
  });

  it('keeps one image failure independent, retries it, and releases the old chapter even without an unloaded event', async () => {
    mocks.acquire.mockRejectedValueOnce(new Error('One image failed'));
    const changed=vi.fn(),errors=vi.fn(),{document,images}=artwork(),window=new EpubImageWindow(changed,errors);window.add(document);visible(images,0);
    window.show(images.map(image=>page(image.getAttribute('data-nc-epub-image')!)),true,'classic','en','account-a');
    await vi.waitFor(()=>expect(images[1].getAttribute('src')).toMatch(/^blob:translated/));
    expect(images[0].getAttribute('src')).toBe('blob:original-0');expect(errors).toHaveBeenCalledWith('OPS/0.png','One image failed');
    window.retry('OPS/0.png');await vi.waitFor(()=>expect(images[0].getAttribute('src')).toMatch(/^blob:translated/));
    window.add(artwork([]).document);expect(changed).toHaveBeenLastCalledWith([]);
    expect(images[0].getAttribute('src')).toBe('blob:original-0');expect(revoke).toHaveBeenCalledTimes(4);window.close();
  });
});
