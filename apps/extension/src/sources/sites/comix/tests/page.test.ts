import {afterEach,describe,expect,it,vi} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {comicImageRect,renderedImageRect} from '../../../shared/geometry';
import {sourceFor} from '../../..';

const url='https://comix.to/title/nr83-sample/123-chapter-1';
function fixture() {
  const ordinary={tagName:'IMG',src:'https://images.example/page.png',currentSrc:'',complete:true,
    naturalWidth:760,naturalHeight:60,width:760,height:60,isConnected:true,
    getBoundingClientRect:()=>({width:760,height:60}),checkVisibility:()=>true};
  const canvas={tagName:'CANVAS',width:760,height:1200,isConnected:true,
    toBlob:vi.fn((done:(blob:Blob)=>void)=>done(new Blob(['decoded pixels'],{type:'image/png'})))};
  const slot=(n:string,element:object)=>({dataset:{page:n},loading:false,error:false,
    matches(selector:string){return selector==='.rpage-page'||this.loading||this.error;},
    querySelector:()=>element});
  const slots=[slot('2',canvas),slot('1',ordinary)];
  const doc={title:'Fixture',documentElement:{},querySelector:()=>null,addEventListener(){},removeEventListener(){},
    querySelectorAll:(selector:string)=>selector.includes('> img.') ? [ordinary] : slots} as unknown as Document;
  const navigation=createSourceNavigation(doc),session=navigation.get(url).session;
  return {ordinary,canvas,slots,doc,navigation,session};
}
afterEach(()=>vi.unstubAllGlobals());
describe('Comix inline page selection',()=>{
  it('uses its own image/canvas targets in source page order and keeps full acquisition on HTTP',async()=>{
    const {session,ordinary,canvas}=fixture();
    expect(sourceFor(url).definition.capabilities.inline).toBe(true);
    const targets=session.inlineTargets();
    expect(targets.map(image=>image.element)).toEqual([ordinary,canvas]);
    expect(targets[0].url).toBe(ordinary.src);
    expect(targets[1].url).toMatch(/^page-image:/);
    expect(session.inlineTargets().map(image=>image.url)).toEqual(targets.map(image=>image.url));
    expect(await targets[1].read!()).toEqual(new Blob(['decoded pixels'],{type:'image/png'}));
    expect(await session.discoverPages()).toEqual({status:'unsupported',code:'NETWORK_SOURCE_REQUIRED'});
    expect(session.snapshot()).toMatchObject({items:[],discoveryComplete:false});
  });
  it('does not apply unknown-site large-image heuristics to short loaded comic slices',()=>{
    vi.stubGlobal('getComputedStyle',()=>({visibility:'visible',opacity:'1'}));
    const {ordinary,session}=fixture();
    expect(session.inlineTargets()).toHaveLength(2);
    expect(comicImageRect(ordinary as unknown as HTMLImageElement)).toBeUndefined();
    expect(renderedImageRect(ordinary as unknown as HTMLImageElement)).toMatchObject({width:760,height:60});
  });
  it('waits for loading/failed/empty images and never falls back on catalog or unsupported Comix pages',()=>{
    const {ordinary,canvas,slots,session,navigation}=fixture();
    slots[0].loading=true;ordinary.complete=false;
    expect(session.inlineTargets()).toEqual([]);
    slots[0].loading=false;slots[0].error=true;ordinary.complete=true;
    expect(session.inlineTargets().map(image=>image.element)).toEqual([ordinary]);
    slots[0].error=false;canvas.width=0;
    expect(session.inlineTargets()).toHaveLength(1);
    expect(navigation.get('https://comix.to/title/nr83-sample').session.inlineTargets()).toEqual([]);
    expect(navigation.get('https://comix.to/browse').session.inlineTargets()).toEqual([]);
  });
  it.each(['detach','resize','rebind','navigate','dispose'])('invalidates canvas reads after %s',async change=>{
    const {canvas,slots,session,navigation}=fixture(),target=session.inlineTargets()[1];
    if(change==='detach')canvas.isConnected=false;
    if(change==='resize')canvas.width=761;
    if(change==='rebind')slots[0].dataset.page='3';
    if(change==='navigate')navigation.get(url.replace('123-chapter-1','124-chapter-2'));
    if(change==='dispose')session.dispose();
    await expect(target.read!()).rejects.toThrow();
    expect(canvas.toBlob).not.toHaveBeenCalled();
  });
  it.each(['class','data-page'])('invalidates canvas redraws when %s changes and returns to its old value between scans',async attributeName=>{
    let callback:MutationCallback=()=>{};
    vi.stubGlobal('MutationObserver',class {constructor(fn:MutationCallback){callback=fn;}observe(){}disconnect(){}takeRecords(){return [];}});
    const {slots,session}=fixture(),changed=vi.fn();
    const cleanup=session.observe!(changed),before=session.inlineTargets()[1];
    callback([{target:slots[0],attributeName,oldValue:attributeName==='class'?'rpage-page':'2'},
      {target:slots[0],attributeName,oldValue:attributeName==='class'?'rpage-page is-loading':'3'}] as unknown as MutationRecord[],{} as MutationObserver);
    expect(changed).toHaveBeenCalled();
    expect(session.inlineTargets()[1].url).not.toBe(before.url);
    await expect(before.read!()).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
    cleanup();
  });
});
