import {afterEach,describe,expect,it,vi} from 'vitest';
import {receiveImage} from '../src/inline/blob-transfer';
import {installRegion} from '../src/region/content';
import {capturePlacement,RegionDisplay} from '../src/region/display';
import type {RegionImageRequest,RegionRequest,RegionResponse} from '../src/region/protocol';

vi.mock('../src/inline/blob-transfer',()=>({receiveImage:vi.fn()}));
vi.mock('../src/inline/theme',()=>({connectInlineTheme:vi.fn()}));
vi.mock('../src/inline/shadow',()=>({shadowThemeStyles:()=>''}));
vi.mock('../src/i18n/runtime',()=>({msg:(value:string)=>value,subscribeLocale:()=>()=>{}}));
vi.mock('../src/translation/notice',()=>({translationNotice:(state:{message:string;kind:string;retryAction?:string})=>({
  message:state.message,detail:state.message,label:state.retryAction==='translate'?'重新翻译':'点击重新加载',
})}));
vi.mock('../src/region/display',()=>({
  capturePlacement:vi.fn((rect:object)=>({kind:'viewport',box:rect})),
  placementBox:(placement:{box:object;kind:string})=>placement.kind==='preview'?undefined:placement.box,
  imagePlacementValid:()=>true,
  RegionDisplay:vi.fn(class {
    key?:string;
    show=vi.fn(async(_blob:Blob,key:string,current:()=>boolean)=>{if(current())this.key=key;});
    paint=vi.fn();paintLoading=vi.fn();
    clear=vi.fn(()=>{this.key=undefined;});
  }),
}));

type Listener=(event:any)=>void;
class Node {
  children:Node[]=[];parent?:Node;shadow?:Node;
  listeners=new Map<string,Set<Listener>>();attributes=new Map<string,string>();
  className='';textContent='';hidden=false;disabled=false;alt='';type='';tabIndex=0;
  dataset:Record<string,string>={};onclick?:()=>void;
  style={cssText:'',setProperty:vi.fn(),removeProperty:vi.fn()};
  constructor(readonly tag='div'){}
  append(...children:Node[]){for(const child of children){child.parent=this;this.children.push(child);}}
  prepend(child:Node){child.parent=this;this.children.unshift(child);}
  attachShadow(){this.shadow=new Node('shadow');return this.shadow;}
  contains(node:Node){for(let current:Node|undefined=node;current;current=current.parent)if(current===this)return true;return false;}
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  getAttribute(name:string){return this.attributes.get(name)??null;}
  removeAttribute(name:string){this.attributes.delete(name);}
  get src(){return this.getAttribute('src')??'';}
  set src(value:string){this.setAttribute('src',value);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=undefined;}
  focus(){}setPointerCapture(){}releasePointerCapture(){}
  addEventListener(type:string,listener:Listener){let listeners=this.listeners.get(type);if(!listeners)this.listeners.set(type,listeners=new Set());listeners.add(listener);}
  removeEventListener(type:string,listener:Listener){this.listeners.get(type)?.delete(listener);}
  emit(type:string,extra:Record<string,unknown>={}){
    const event={type,target:this,isTrusted:true,isPrimary:true,button:0,buttons:1,pointerId:1,clientX:20,clientY:20,
      preventDefault:vi.fn(),stopPropagation:vi.fn(),composedPath:()=>[this],...extra};
    for(const listener of this.listeners.get(type)??[])listener(event);
  }
  find(predicate:(node:Node)=>boolean):Node|undefined{
    if(predicate(this))return this;
    for(const child of this.children){const found=child.find(predicate);if(found)return found;}
  }
}
const flush=async()=>{for(let count=0;count<16;count++)await Promise.resolve();};
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});
  return {promise,resolve,reject};
}
function fixture(){
  vi.useFakeTimers();
  vi.mocked(receiveImage).mockReset();vi.mocked(RegionDisplay).mockClear();
  vi.mocked(capturePlacement).mockImplementation(rect=>({kind:'viewport',box:rect}));
  const documentNode=Object.assign(new Node('document'),{hidden:false,documentElement:new Node('html'),createElement:(tag:string)=>new Node(tag)});
  const windowNode=new Node('window'),frames=new Map<number,FrameRequestCallback>();let frameId=0;
  let mutation:MutationCallback=()=>{};
  vi.stubGlobal('document',documentNode);vi.stubGlobal('window',windowNode);vi.stubGlobal('Element',Node);
  vi.stubGlobal('location',{href:'https://fixture.invalid/chapter'});vi.stubGlobal('navigator',{onLine:true});
  vi.stubGlobal('innerWidth',1200);vi.stubGlobal('innerHeight',900);vi.stubGlobal('devicePixelRatio',1);
  vi.stubGlobal('scrollX',0);vi.stubGlobal('scrollY',0);vi.stubGlobal('visualViewport',null);
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  vi.stubGlobal('MutationObserver',class {constructor(callback:MutationCallback){mutation=callback;}observe(){}disconnect(){}});
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  let serial=0;
  const create=vi.spyOn(URL,'createObjectURL').mockImplementation(()=>`blob:fixture-${++serial}`);
  const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  const messages:RegionRequest[]=[],reads:RegionImageRequest[]=[];
  let listener!:(message:unknown,sender:object,respond:(value:unknown)=>void)=>void;
  let reply:(request:RegionRequest)=>Partial<RegionResponse>|Promise<Partial<RegionResponse>>=()=>({submitted:true,resultKey:'result-one'});
  let read:(request:RegionImageRequest,signal?:AbortSignal)=>Promise<Blob>=async()=>new Blob(['fixture']);
  vi.mocked(receiveImage).mockImplementation((_port,request,signal)=>{
    reads.push(request as RegionImageRequest);return read(request as RegionImageRequest,signal);
  });
  vi.stubGlobal('chrome',{runtime:{id:'fixture-extension',connect:vi.fn(()=>({})),
    onMessage:{addListener:(callback:typeof listener)=>{listener=callback;}},
    sendMessage:vi.fn(async(request:RegionRequest)=>{
      messages.push(request);
      if(request.type==='NC_REGION_CAPTURE')return {ok:true,data:{selectionId:request.selectionId,rect:request.rect,width:200,height:150,submitted:false}};
      if(['NC_REGION_SUBMIT','NC_REGION_TICK','NC_REGION_WAIT','NC_REGION_RETRY'].includes(request.type))
        return {ok:true,data:{selectionId:request.selectionId,rect:{x:20,y:20,width:200,height:150},width:200,height:150,...await reply(request)}};
      return {ok:true};
    }),
  }});
  installRegion();listener({type:'NC_REGION_START'},{id:'fixture-extension'},()=>{});
  const host=documentNode.documentElement.children[0],surface=host.shadow!;
  const find=(predicate:(node:Node)=>boolean)=>{const node=surface.find(predicate);if(!node)throw Error('Fixture node not found');return node;};
  const button=(label:string)=>find(node=>node.tag==='button'&&node.textContent===label&&!node.hidden);
  const preview=find(node=>node.className==='preview');
  const frame=()=>{const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(0);};
  return {messages,reads,documentNode,preview,create,revoke,button,
    setReply(value:typeof reply){reply=value;},setRead(value:typeof read){read=value;},
    async select(){
      const mask=find(node=>node.className==='selector');
      mask.emit('pointerdown');mask.emit('pointermove',{clientX:220,clientY:170});mask.emit('pointerup',{clientX:220,clientY:170});
      frame();frame();await flush();
    },
    change(){mutation([{target:documentNode.documentElement}] as unknown as MutationRecord[],{} as MutationObserver);},
    async visibility(hidden:boolean){documentNode.hidden=hidden;documentNode.emit('visibilitychange');await vi.advanceTimersByTimeAsync(0);await flush();},
    stop(){listener({type:'NC_REGION_STOP'},{id:'fixture-extension'},()=>{});},
  };
}

afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('region crop preview and explicit retries',()=>{
  it('submits immediately without transferring the source, and reads an original preview only when opened',async()=>{
    const f=fixture();await f.select();
    expect(f.messages.filter(message=>message.type==='NC_REGION_SUBMIT')).toHaveLength(1);
    expect(f.reads.map(request=>request.kind)).toEqual(['result']);expect(f.preview.hidden).toBe(true);
    f.button('恢复原图').onclick!();expect(f.reads.map(request=>request.kind)).toEqual(['result']);
    f.button('显示预览').onclick!();await flush();expect(f.reads.map(request=>request.kind)).toEqual(['result','source']);
    f.button('关闭预览').onclick!();f.button('显示预览').onclick!();await flush();
    expect(f.reads.filter(request=>request.kind==='source')).toHaveLength(1);f.stop();
  });
  it('does not reopen an already-dismissed fallback on later scroll or DOM changes',async()=>{
    const f=fixture();await f.select();f.documentNode.emit('scroll');expect(f.preview.hidden).toBe(false);
    f.button('关闭预览').onclick!();f.documentNode.emit('scroll');f.change();
    expect(f.preview.hidden).toBe(true);expect(f.reads.filter(request=>request.kind==='source')).toHaveLength(0);f.stop();
  });
  it('does not reopen a preview-only result when an unrelated page mutation first occurs',async()=>{
    const f=fixture();vi.mocked(capturePlacement).mockImplementation(rect=>({kind:'preview',box:rect}));await f.select();
    expect(f.preview.hidden).toBe(false);f.button('关闭预览').onclick!();f.change();
    expect(f.preview.hidden).toBe(true);f.stop();
  });
  it('routes missing local results to an explicit new translation rather than rereading the missing key',async()=>{
    const f=fixture();let failed=false;
    f.setRead(async request=>{if(!failed){failed=true;throw Object.assign(Error('local result missing'),{code:'RESULT_NOT_CACHED'});}return new Blob([request.resultKey!]);});
    f.setReply(request=>({submitted:true,resultKey:request.type==='NC_REGION_RETRY'?'result-two':'result-one'}));
    await f.select();expect(f.messages.filter(message=>message.type==='NC_REGION_RETRY')).toHaveLength(0);
    expect(f.reads.map(request=>request.resultKey)).toEqual(['result-one']);
    f.button('重新翻译').onclick!();await flush();
    expect(f.messages.filter(message=>message.type==='NC_REGION_RETRY')).toHaveLength(1);
    expect(f.reads.map(request=>request.resultKey)).toEqual(['result-one','result-two']);f.stop();
  });
  it('retries a regular result-read failure at the same key without a translation request',async()=>{
    const f=fixture();let failed=false;
    f.setRead(async()=>{if(!failed){failed=true;throw Error('download interrupted');}return new Blob(['result']);});
    await f.select();f.button('点击重新加载').onclick!();await flush();
    expect(f.messages.filter(message=>message.type==='NC_REGION_RETRY')).toHaveLength(0);
    expect(f.reads.map(request=>request.resultKey)).toEqual(['result-one','result-one']);f.stop();
  });
  it('honors the restored background missing-result action without starting work until clicked',async()=>{
    const f=fixture();
    f.setReply(request=>request.type==='NC_REGION_RETRY'?{submitted:true,resultKey:'replacement'}:
      {submitted:true,state:{kind:'error',message:'local result missing',retryAction:'translate'}});
    await f.select();expect(f.reads).toHaveLength(0);expect(f.messages.filter(message=>message.type==='NC_REGION_RETRY')).toHaveLength(0);
    f.button('重新翻译').onclick!();await flush();
    expect(f.messages.filter(message=>message.type==='NC_REGION_RETRY')).toHaveLength(1);
    expect(f.reads.map(request=>request.resultKey)).toEqual(['replacement']);f.stop();
  });
  it('keeps a source-preview failure separate from submission and the translated result, with an explicit read retry',async()=>{
    const f=fixture(),submission=deferred<Partial<RegionResponse>>();let failSource=true;
    f.setReply(()=>submission.promise);
    f.setRead(async request=>{if(request.kind==='source'&&failSource){failSource=false;throw Error('source transfer interrupted');}return new Blob([request.kind]);});
    await f.select();expect(f.messages.filter(message=>message.type==='NC_REGION_SUBMIT')).toHaveLength(1);expect(f.reads).toHaveLength(0);
    f.button('显示预览').onclick!();await flush();
    expect(f.button('点击重新加载')).toBeDefined();
    submission.resolve({submitted:true,resultKey:'result-one'});await flush();
    expect(f.reads.map(request=>request.kind)).toEqual(['source','result']);expect(f.button('恢复原图')).toBeDefined();
    f.button('恢复原图').onclick!();f.button('点击重新加载').onclick!();await flush();
    expect(f.reads.map(request=>request.kind)).toEqual(['source','result','source']);
    expect(f.messages.filter(message=>message.type==='NC_REGION_SUBMIT')).toHaveLength(1);f.stop();
  });
  it.each(['close-preview','hide-tab','close-selection'])('cancels a pending original preview on %s and discards a late source',async action=>{
    const f=fixture(),source=deferred<Blob>();let signal:AbortSignal|undefined;
    f.setRead(async(request,value)=>{if(request.kind==='source'){signal=value;return source.promise;}return new Blob(['result']);});
    await f.select();f.button('恢复原图').onclick!();f.button('显示预览').onclick!();await flush();
    const before=f.create.mock.calls.length;
    if(action==='close-preview')f.button('关闭预览').onclick!();
    else if(action==='hide-tab')await f.visibility(true);
    else f.stop();
    expect(signal?.aborted).toBe(true);source.resolve(new Blob(['late source']));await flush();
    expect(f.create).toHaveBeenCalledTimes(before);f.stop();
  });
  it('resumes only the open original preview and never lets its old hidden-tab response replace the new read',async()=>{
    const f=fixture(),oldSource=deferred<Blob>(),newSource=deferred<Blob>();let sourceReads=0;
    f.setRead(async request=>request.kind==='source'?(sourceReads++===0?oldSource.promise:newSource.promise):new Blob(['result']));
    await f.select();f.button('恢复原图').onclick!();f.button('显示预览').onclick!();await flush();
    const before=f.create.mock.calls.length;
    await f.visibility(true);await f.visibility(false);
    expect(f.reads.filter(request=>request.kind==='source')).toHaveLength(2);
    oldSource.resolve(new Blob(['stale']));await flush();expect(f.create).toHaveBeenCalledTimes(before);
    newSource.resolve(new Blob(['current']));await flush();expect(f.create).toHaveBeenCalledTimes(before+1);
    expect(f.messages.filter(message=>message.type==='NC_REGION_SUBMIT')).toHaveLength(1);
    expect(f.messages.filter(message=>message.type==='NC_REGION_RETRY')).toHaveLength(0);f.stop();
  });
});
