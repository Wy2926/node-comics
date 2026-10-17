import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createReaderImageURL,releaseReaderImageURL,retainReaderImageURL} from '../src/reader/image-urls';
import {pageSnapshot} from '../src/reader/page-snapshot';

let serial=0;
beforeEach(()=>{
 vi.spyOn(URL,'createObjectURL').mockImplementation(()=>`blob:reader-unit-${++serial}`);
 vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
describe('reader image URL ownership',()=>{
 it('keeps the outgoing URL alive when its React owner releases before the snapshot',()=>{
  const blob=new Blob(['pixels']),url=createReaderImageURL(blob),releaseSnapshot=retainReaderImageURL(url);
  expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(blob);releaseReaderImageURL(url);expect(URL.revokeObjectURL).not.toHaveBeenCalled();releaseSnapshot();expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url);
 });
 it('does not revoke an owned URL when the snapshot releases first',()=>{
  const url=createReaderImageURL(new Blob(['pixels'])),releaseSnapshot=retainReaderImageURL(url);
  releaseSnapshot();expect(URL.revokeObjectURL).not.toHaveBeenCalled();releaseReaderImageURL(url);expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url);
 });
 it('waits for the last of multiple independent snapshot pins',()=>{
  const url=createReaderImageURL(new Blob(['pixels'])),first=retainReaderImageURL(url),second=retainReaderImageURL(url),third=retainReaderImageURL(url);
  releaseReaderImageURL(url);second();first();expect(URL.revokeObjectURL).not.toHaveBeenCalled();third();expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url);
 });
 it('makes repeated pin releases harmless without consuming another pin or another URL owner',()=>{
  const first=createReaderImageURL(new Blob(['first'])),second=createReaderImageURL(new Blob(['second']));
  const pinA=retainReaderImageURL(first),pinB=retainReaderImageURL(first),pinOther=retainReaderImageURL(second);
  releaseReaderImageURL(first);pinA();pinA();expect(URL.revokeObjectURL).not.toHaveBeenCalled();pinB();pinB();releaseReaderImageURL(first);expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(first);
  releaseReaderImageURL(second);expect(URL.revokeObjectURL).toHaveBeenCalledOnce();pinOther();pinOther();expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);expect(URL.revokeObjectURL).toHaveBeenLastCalledWith(second);
 });
 it('does not adopt or revoke URLs owned outside the reader',()=>{
  const unknown='blob:external-owner',release=retainReaderImageURL(unknown);release();release();releaseReaderImageURL(unknown);expect(URL.createObjectURL).not.toHaveBeenCalled();expect(URL.revokeObjectURL).not.toHaveBeenCalled();
 });
 it('releases an unshared owner once and cannot revive an already revoked URL',()=>{
  const url=createReaderImageURL(new Blob(['pixels']));releaseReaderImageURL(url);releaseReaderImageURL(url);const release=retainReaderImageURL(url);release();expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url);
 });
});

class ElementStub extends EventTarget{
 parent?:ElementStub;children:ElementStub[]=[];attributes=new Map<string,string>();style:Record<string,string>={};
 className='';inert=false;clientWidth=800;clientHeight=600;clientLeft=2;clientTop=3;scrollLeft=0;scrollTop=40;offsetWidth=640;offsetHeight=900;
 left=10;top=20;complete=false;naturalWidth=0;naturalHeight=0;decode=vi.fn(()=>new Promise<void>(()=>{}));
 constructor(readonly tagName='DIV'){super();}
 setAttribute(name:string,value:string){this.attributes.set(name,value);}
 removeAttribute(name:string){this.attributes.delete(name);}
 getAttributeNames(){return [...this.attributes.keys()];}
 get src(){return this.attributes.get('src')??'';}
 set src(value:string){this.attributes.set('src',value);}
 append(child:ElementStub){child.parent=this;this.children.push(child);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=undefined;}
 querySelectorAll(selector:string):ElementStub[]{
  const all=this.children.flatMap(child=>[child,...child.querySelectorAll('*')]);
  return all.filter(element=>selector==='*'||selector==='img'&&element.tagName==='IMG'||selector==='.nc-page-image-pending'&&element.className==='nc-page-image-pending');
 }
 getBoundingClientRect(){return {left:this.left,top:this.top};}
}

describe('outgoing page snapshot',()=>{
 function fixture(){
  const viewport=new ElementStub(),surface=new ElementStub(),pixels=new ElementStub(),image=new ElementStub('IMG'),pending=new ElementStub('IMG');
  surface.left=100;surface.top=-70;pixels.setAttribute('id','reader-page');pixels.setAttribute('data-page-id','page-1');pixels.setAttribute('data-direction','rtl');pixels.setAttribute('data-paged','true');
  image.src=createReaderImageURL(new Blob(['visible pixels']));image.setAttribute('id','reader-image');image.setAttribute('data-source','old-page');
  pending.src=createReaderImageURL(new Blob(['pending pixels']));pending.className='nc-page-image-pending';pixels.append(image);pixels.append(pending);
  const cloneNode=vi.fn(()=>pixels);Object.assign(surface,{cloneNode});
  vi.stubGlobal('document',{createElement:()=>new ElementStub()});
  return {viewport,surface,pixels,image,pending,cloneNode,create:()=>pageSnapshot(viewport as unknown as HTMLDivElement,surface as unknown as HTMLDivElement,25)};
 }
 it('clones synchronously without waiting for image decoding and pins only displayed URLs',()=>{
  vi.useFakeTimers();const f=fixture(),url=f.image.src,pendingURL=f.pending.src;
  const imageListener=vi.spyOn(f.image,'addEventListener'),snapshot=f.create(),host=f.viewport.children[0];
  expect(f.cloneNode).toHaveBeenCalledExactlyOnceWith(true);expect(snapshot).not.toHaveProperty('ready');expect(snapshot).not.toHaveProperty('show');
  expect(f.image.decode).not.toHaveBeenCalled();expect(imageListener).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  expect(snapshot.element.style.visibility).toBeUndefined();expect(snapshot.element.inert).toBe(true);expect(snapshot.element.getAttributeNames()).toEqual(['data-swipe-snapshot','aria-hidden']);
  expect(f.pixels.getAttributeNames()).toEqual(['data-direction','data-paged']);expect(f.image.getAttributeNames()).toEqual(['src']);expect(f.pending.parent).toBeUndefined();
  expect(f.pixels.style).toMatchObject({left:'63px',top:'-93px',width:'640px',height:'900px',transform:'none'});expect(host.style).toMatchObject({width:'800px',height:'600px',left:'0px',top:'40px'});
  releaseReaderImageURL(url);expect(URL.revokeObjectURL).not.toHaveBeenCalled();releaseReaderImageURL(pendingURL);expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(pendingURL);
  snapshot.dispose();snapshot.dispose();expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);expect(URL.revokeObjectURL).toHaveBeenLastCalledWith(url);expect(f.image.src).toBe('');expect(f.viewport.children).toHaveLength(0);
 });
 it('tracks the viewport pan until disposal without retaining scroll listeners',()=>{
  const f=fixture(),snapshot=f.create(),host=f.viewport.children[0],url=f.image.src,pendingURL=f.pending.src;
  f.viewport.scrollLeft=15;f.viewport.scrollTop=80;f.viewport.dispatchEvent(new Event('scroll'));expect(host.style).toMatchObject({left:'15px',top:'80px'});
  snapshot.dispose();expect(URL.revokeObjectURL).not.toHaveBeenCalled();f.viewport.scrollTop=200;f.viewport.dispatchEvent(new Event('scroll'));expect(host.style.top).toBe('80px');
  releaseReaderImageURL(url);releaseReaderImageURL(pendingURL);expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
 });
});
