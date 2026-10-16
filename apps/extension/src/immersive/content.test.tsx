import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Children,isValidElement,type ReactNode} from 'react';
import {installImmersive} from './content';
import {IMMERSIVE_SOURCE_PORT,type ImmersiveImage,type ImmersiveSession} from './protocol';
import {IMAGE_CHUNK_BYTES} from '../inline/blob-transfer';
import {defaults} from '../types';
import type {PageImage} from '../sources/contracts/page';
import {bindWebShortcuts} from '../shortcuts/web-content';

const dependency=vi.hoisted(()=>({document:vi.fn(),image:vi.fn(),render:vi.fn(),unmount:vi.fn()}));
vi.mock('react-dom/client',()=>({createRoot:()=>({render:dependency.render,unmount:dependency.unmount})}));
vi.mock('../reader/SessionReader',()=>({SessionReader:()=>null,sessionReaderStyles:''}));
vi.mock('../icons',()=>({IconSpriteContext:'icons'}));
vi.mock('../sources/page',()=>({MAX_COMIC_IMAGES:1500,sourceDocument:dependency.document,pageImageReferrerPolicy:()=>undefined}));
vi.mock('../sources',()=>({sourceImage:dependency.image,sourceFor:(url:string)=>({
  definition:{id:'generic',capabilities:{importable:false}},location:{kind:'reader',sourceId:'generic',url},
})}));
vi.mock('../inline/shadow',()=>({shadowThemeStyles:()=>''}));
vi.mock('../inline/theme',()=>({connectInlineTheme:()=>()=>{}}));
vi.mock('../i18n/runtime',()=>({msg:(value:string)=>value,subscribeLocale:()=>()=>{}}));
vi.mock('../shortcuts/web-content',()=>({bindWebShortcuts:vi.fn(()=>vi.fn())}));

type Listener=(...args:any[])=>any;
function event(){
  const listeners=new Set<Listener>();
  return {addListener:(value:Listener)=>listeners.add(value),removeListener:(value:Listener)=>listeners.delete(value),
    emit:(...args:any[])=>[...listeners].map(listener=>listener(...args))};
}
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};
}
class FixtureElement {
  children:FixtureElement[]=[];parentElement:FixtureElement|null=null;isConnected=true;
  shadow?:FixtureElement;
  activeElement:FixtureElement|null=null;
  clientTop=0;clientLeft=0;clientHeight=1100;clientWidth=800;scrollHeight=1100;scrollTop=0;
  naturalWidth=800;naturalHeight=1100;className='';textContent='';dataset:Record<string,string>={};
  private attributes=new Map<string,string>();
  private styles=new Map<string,{value:string;priority:string}>();
  style={cssText:'',getPropertyValue:(key:string)=>this.styles.get(key)?.value??'',
    getPropertyPriority:(key:string)=>this.styles.get(key)?.priority??'',
    setProperty:(key:string,value:string,priority='')=>this.styles.set(key,{value,priority}),
    removeProperty:(key:string)=>this.styles.delete(key),length:0};
  constructor(readonly ownerDocument:Document,readonly tagName:string,public top=0){}
  append(...children:FixtureElement[]){for(const child of children){child.parentElement=this;this.children.push(child);}}
  attachShadow(){return this.shadow=new FixtureElement(this.ownerDocument,'SHADOW');}
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  hasAttribute(name:string){return this.attributes.has(name);}
  removeAttribute(name:string){this.attributes.delete(name);}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.isConnected=false;}
  contains(value:FixtureElement):boolean{
    for(let at:FixtureElement|null=value;at;at=at.parentElement)if(at===this)return true;return false;
  }
  matches(selector:string){return selector.split(',').some(part=>part.toUpperCase()===this.tagName);}
  closest(selector:string):FixtureElement|null{
    for(let at:FixtureElement|null=this;at;at=at.parentElement)if(at.matches(selector))return at;return null;
  }
  getBoundingClientRect(){return {top:this.top,bottom:this.top+1100,left:200,right:1000,width:800,height:1100};}
  getRootNode():FixtureElement{return this.parentElement?.getRootNode()??this;}
  focus(_options?:FocusOptions){this.getRootNode().activeElement=this;}
}
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const descendants=(element:FixtureElement):FixtureElement[]=>[element,...element.children.flatMap(descendants)];
const url='https://generic.example/chapter',navigationId='navigation-one';
function fixture(networkSession?:ImmersiveSession){
  const documentListeners=new Map<string,Set<Listener>>();
  const doc={title:'Source chapter',hidden:false,activeElement:null,
    addEventListener:vi.fn((type:string,listener:Listener)=>{const listeners=documentListeners.get(type)??new Set<Listener>();listeners.add(listener);documentListeners.set(type,listeners);}),
    removeEventListener:vi.fn((type:string,listener:Listener)=>documentListeners.get(type)?.delete(listener)),
    defaultView:{innerWidth:1200,innerHeight:800}} as unknown as Document;
  const html=new FixtureElement(doc,'HTML'),body=new FixtureElement(doc,'BODY'),main=new FixtureElement(doc,'MAIN');
  html.append(body);body.append(main);
  Object.assign(doc,{documentElement:html,body,createElement:(tag:string)=>new FixtureElement(doc,tag.toUpperCase()),importNode:(node:unknown)=>node});
  vi.stubGlobal('document',doc);vi.stubGlobal('Element',FixtureElement);vi.stubGlobal('HTMLElement',FixtureElement);
  vi.stubGlobal('window',{addEventListener:vi.fn(),scrollBy:vi.fn()});vi.stubGlobal('location',{href:url});
  vi.stubGlobal('getComputedStyle',()=>({overflowY:'visible'}));
  vi.stubGlobal('DOMParser',class {parseFromString(){return {documentElement:new FixtureElement(doc,'SVG')};}});
  let subscriber:{changed():void;invalidated():void}|undefined;
  const targets:PageImage[]=[];
  const page={navigationId,url,location:{kind:'reader',sourceId:'generic'},controller:new AbortController(),
    session:{direction:'rtl',inlineTargets:()=>targets}};
  dependency.document.mockReturnValue({current:()=>page,subscribe:(value:typeof subscriber)=>{subscriber=value;return ()=>{subscriber=undefined;};}});
  const messages=event(),connections=event(),binds:ImmersiveSession[]=[];
  let nextBind:Promise<void>|undefined,nextSessionId='session-one';
  vi.stubGlobal('chrome',{runtime:{id:'extension',getURL:(path:string)=>'chrome-extension://extension/'+path,
    onMessage:messages,onConnect:connections,
    sendMessage:vi.fn(async(message:{type:string;images:ImmersiveImage[]})=>{
      if(message.type==='NC_IMMERSIVE_RESOLVE')return {ok:true,data:{settings:defaults,session:networkSession}};
      if(message.type==='NC_IMMERSIVE_BIND'){
        const session:ImmersiveSession={id:nextSessionId,navigationId,url,title:'Chapter',direction:'rtl',complete:false,images:message.images};
        const pending=nextBind;nextBind=undefined;
        binds.push(session);if(pending)await pending;return {ok:true,data:session};
      }
      return {ok:true};
    })}});
  const send=(type:string,extra:Record<string,unknown>={})=>{
    let response:unknown;
    messages.emit({type,...extra},{id:'extension'},(value:unknown)=>{response=value;});return response;
  };
  const add=(name:string,read:PageImage['read']=async()=>new Blob(['source'],{type:'image/png'}))=>{
    const element=new FixtureElement(doc,'IMG',targets.length*1100);main.append(element);
    const target:PageImage={element:element as unknown as HTMLImageElement,key:name,url:'blob:'+url+'/'+name,read};
    targets.push(target);return target;
  };
  const sourcePort=(id:string)=>{
    const input=event(),disconnected=event(),output:Array<{type:string;offset?:number;size?:number;data?:string}>=[];
    const port={name:IMMERSIVE_SOURCE_PORT,sender:{id:'extension',url:'chrome-extension://extension/background.js'},
      onMessage:input,onDisconnect:disconnected,postMessage:vi.fn(value=>output.push(value)),disconnect:vi.fn()};
    connections.emit(port);input.emit({type:'open',request:{navigationId,id}});
    return {output,port,pull:(offset:number)=>input.emit({type:'pull',offset})};
  };
  installImmersive();
  return {doc,html,body,main,page,targets,binds,add,sourcePort,send,
    listeners(type:string){return documentListeners.get(type)?.size??0;},
    dispatch(type:string,properties:Record<string,unknown>={}){
      const value={type,target:doc,preventDefault:vi.fn(),stopImmediatePropagation:vi.fn(),...properties};
      for(const listener of [...documentListeners.get(type)??[]])listener(value);return value;
    },
    delayNextBind(pending:Promise<void>){nextBind=pending;},
    replaceNextSession(){nextSessionId='replacement-session';},
    async start(){send('NC_IMMERSIVE_PREPARE');send('NC_IMMERSIVE_SHOW',{navigationId});await flush();expect(binds).toHaveLength(networkSession?0:1);},
    async change(){subscriber?.changed();await vi.advanceTimersByTimeAsync(120);await flush();},
    stop(){send('NC_IMMERSIVE_STOP');},
  };
}
beforeEach(()=>{vi.resetAllMocks();vi.useFakeTimers();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

function renderedElements(node:ReactNode):Array<{type:unknown;props:Record<string,any>}>{
  return Children.toArray(node).flatMap(child=>isValidElement<Record<string,any>>(child)?[child,...renderedElements(child.props.children)]:[]);
}
const rendered=()=>renderedElements(dependency.render.mock.calls.at(-1)![0]);

describe('immersive preparation feedback',()=>{
  it.each(['stopped','navigated','replaced-navigation','wrong-navigation','missing-navigation'] as const)('rejects a %s SHOW without creating a host or locking source scrolling',async(reason)=>{
    const f=fixture();f.add('first');f.send('NC_IMMERSIVE_PREPARE');
    if(reason==='stopped')f.stop();
    if(reason==='navigated')location.href=url+'/next';
    if(reason==='replaced-navigation')f.page.navigationId='replacement-navigation';
    const identity=reason==='missing-navigation'?{}:{navigationId:reason==='wrong-navigation'?'other-navigation':navigationId};
    expect(f.send('NC_IMMERSIVE_SHOW',identity)).toEqual({ok:false});await flush();
    expect(f.html.children).toEqual([f.body]);expect(dependency.render).not.toHaveBeenCalled();
    expect(f.binds).toHaveLength(0);
    for(const element of [f.html,f.body])expect(element.style.getPropertyValue('overflow')).toBe('');
    f.stop();
  });

  it('acknowledges a duplicate current SHOW without creating another host or reload',async()=>{
    const f=fixture();f.add('first');await f.start();const host=f.html.children.find(element=>element.shadow);
    expect(f.send('NC_IMMERSIVE_SHOW',{navigationId})).toEqual({ok:true});await flush();
    expect(f.html.children.filter(element=>element.shadow)).toEqual([host]);expect(f.binds).toHaveLength(1);f.stop();
  });

  it.each([false,true])('restores the original empty-style attribute presence after cancellation: %s',async(hadStyle)=>{
    const f=fixture(),binding=deferred<void>();f.add('first');f.delayNextBind(binding.promise);
    if(hadStyle)f.html.setAttribute('style','');
    await f.start();
    // Reflect the CSSOM-created attribute which the lightweight fixture does not serialize.
    f.html.setAttribute('style','overflow: hidden !important;');
    const has=vi.spyOn(f.html,'hasAttribute'),remove=vi.spyOn(f.html,'removeAttribute');
    f.stop();
    expect(f.html.style.getPropertyValue('overflow')).toBe('');
    if(!hadStyle){
      expect(has).toHaveBeenCalledWith('style');expect(remove).toHaveBeenCalledWith('style');
      expect(has.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
    }else expect(remove).not.toHaveBeenCalled();
    expect(f.html.hasAttribute('style')).toBe(hadStyle);binding.resolve();await flush();
  });

  it('shows an accessible central loading state and binds the same customizable exit shortcut',async()=>{
    const f=fixture(),binding=deferred<void>();f.add('first');f.delayNextBind(binding.promise);await f.start();
    const start=rendered().find(node=>node.props.className==='nc-session-start')!;
    expect(start.props).toMatchObject({'aria-busy':true,'aria-modal':'true',tabIndex:-1});
    expect(rendered().find(node=>node.props.className==='nc-session-start-state')!.props.role).toBe('status');
    expect(rendered().some(node=>node.props.className==='spinner'&&node.props['aria-hidden']==='true')).toBe(true);
    expect(rendered().filter(node=>node.type==='button')).toHaveLength(1);
    const node=new FixtureElement(f.doc,'DIV'),focus=vi.spyOn(node,'focus'),cleanup=start.props.ref(node);
    expect(focus).toHaveBeenCalledWith({preventScroll:true});
    const [handlers,enabled,target]=vi.mocked(bindWebShortcuts).mock.calls.at(-1)!;
    expect(target).toBe(node);expect(enabled()).toBe(true);
    handlers['web.immersive']!({} as KeyboardEvent);
    expect(dependency.unmount).toHaveBeenCalledOnce();expect(enabled()).toBe(false);cleanup();
    const count=dependency.render.mock.calls.length;binding.resolve();await flush();
    expect(dependency.render).toHaveBeenCalledTimes(count);
  });

  it('can exit with Escape during preparation without a late response reopening or locking the page',async()=>{
    const f=fixture(),binding=deferred<void>();f.add('first');f.delayNextBind(binding.promise);await f.start();
    const event={key:'Escape',nativeEvent:{isComposing:false},preventDefault:vi.fn(),stopPropagation:vi.fn()};
    dependency.render.mock.calls.at(-1)![0].props.onKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();expect(dependency.unmount).toHaveBeenCalledOnce();
    expect(f.html.children.some(node=>node.shadow)).toBe(false);expect(f.html.style.getPropertyValue('overflow')).toBe('');
    const count=dependency.render.mock.calls.length;binding.resolve();await flush();
    expect(dependency.render).toHaveBeenCalledTimes(count);expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces failed preparation with an alert and explicit retry, then removes the loader',async()=>{
    const f=fixture(),binding=deferred<void>();f.add('first');f.delayNextBind(binding.promise);await f.start();
    binding.reject(Error('SOURCE_BIND_UNAVAILABLE'));await flush();
    expect(rendered().find(node=>node.props.className==='nc-session-start')!.props['aria-busy']).toBe(false);
    expect(rendered().find(node=>node.props.className==='nc-session-start-state')!.props.role).toBe('alert');
    expect(rendered().some(node=>node.props.className==='spinner')).toBe(false);
    const retry=rendered().find(node=>node.type==='button'&&node.props.children==='重试')!;
    retry.props.onClick();await flush();
    const reader=dependency.render.mock.calls.at(-1)![0].props.children;
    expect(reader.props.loading).toBe(false);expect(reader.props.pages).toHaveLength(1);f.stop();
  });

  it('keeps existing pages and the anchor on failed reload and coalesces duplicate reloads',async()=>{
    const f=fixture();f.add('first');f.add('second');await f.start();
    const reader=dependency.render.mock.calls.at(-1)![0].props.children;
    const position={pageId:reader.props.pages[1].id,relativeOffset:.4};reader.props.onPosition(position);
    const binding=deferred<void>();f.delayNextBind(binding.promise);reader.props.onReload();reader.props.onReload();await flush();
    const pending=dependency.render.mock.calls.at(-1)![0].props.children;
    expect(f.binds).toHaveLength(2);expect(pending.props.loading).toBe(true);expect(pending.key).toBe(reader.key);
    expect(pending.props.pages).toEqual(reader.props.pages);expect(pending.props.initialAnchor).toEqual(position);
    binding.reject(Error('SOURCE_BIND_UNAVAILABLE'));await flush();
    const failed=dependency.render.mock.calls.at(-1)![0].props.children;
    expect(failed.props.loading).toBe(false);expect(failed.props.notice).toBeTruthy();expect(failed.key).toBe(reader.key);
    expect(failed.props.pages).toEqual(reader.props.pages);expect(failed.props.initialAnchor).toEqual(position);f.stop();
  });
});

describe('region picker theme isolation and restoration',()=>{
  it('keeps picker siblings inside the theme and Escape restores the same reader and scroll locks',async()=>{
    const f=fixture(),first=f.add('first');f.add('second');
    f.html.style.setProperty('overflow','clip');f.body.style.setProperty('overflow','auto');
    const sourceElements=[...f.main.children];await f.start();
    const reader=dependency.render.mock.calls.at(-1)![0].props.children;
    const host=f.html.children.find(element=>element.shadow)!,theme=host.shadow!.children.find(element=>element.className==='theme')!;
    const mount=theme.children.find(element=>element.className==='nc-session-mount')!;
    const trigger=new FixtureElement(f.doc,'BUTTON');mount.append(trigger);trigger.focus();const focus=vi.spyOn(trigger,'focus');
    reader.props.onSelectRegion();
    const hint=theme.children.find(element=>element.className==='nc-session-region-hint')!;
    const highlight=theme.children.find(element=>element.className==='nc-session-region-highlight')!;
    expect(hint.textContent).toContain('Esc');expect(highlight).toBeDefined();
    expect(hint.parentElement).toBe(theme);expect(highlight.parentElement).toBe(theme);expect(mount.children).toEqual([trigger]);
    expect(descendants(f.html).some(element=>element.className.startsWith('nc-session-region-'))).toBe(false);
    expect(theme.dataset.picking).toBe('true');expect(host.style.getPropertyValue('pointer-events')).toBe('none');
    expect(host.style.getPropertyPriority('pointer-events')).toBe('important');
    expect(f.html.style.getPropertyValue('overflow')).toBe('clip');expect(f.body.style.getPropertyValue('overflow')).toBe('auto');
    f.dispatch('pointermove',{target:first.element});expect(highlight.style).toMatchObject({display:'block',left:'200px',width:'800px'});
    host.shadow!.activeElement=null;
    const escape=f.dispatch('keydown',{key:'Escape'});
    expect(focus).toHaveBeenCalledWith({preventScroll:true});expect(host.shadow!.activeElement).toBe(trigger);
    expect(escape.preventDefault).toHaveBeenCalledOnce();expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(theme.dataset.picking).toBeUndefined();expect(theme.children).toEqual([mount]);
    expect(hint.isConnected).toBe(false);expect(highlight.isConnected).toBe(false);
    expect(host.style.getPropertyValue('pointer-events')).toBe('auto');expect(host.style.getPropertyPriority('pointer-events')).toBe('important');
    for(const element of [f.html,f.body]){
      expect(element.style.getPropertyValue('overflow')).toBe('hidden');expect(element.style.getPropertyPriority('overflow')).toBe('important');
    }
    for(const type of ['pointermove','click','keydown'])expect(f.listeners(type)).toBe(0);
    expect(dependency.unmount).not.toHaveBeenCalled();expect(dependency.render.mock.calls.at(-1)![0].props.children).toBe(reader);
    expect(f.main.children).toEqual(sourceElements);expect(f.binds).toHaveLength(1);expect(window.scrollBy).not.toHaveBeenCalled();
    f.stop();expect(f.html.style.getPropertyValue('overflow')).toBe('clip');expect(f.body.style.getPropertyValue('overflow')).toBe('auto');
  });

  it('completes a source-DOM selection without inserting picker elements into the document',async()=>{
    const f=fixture(),first=f.add('first');f.add('second');await f.start();
    const sourceElements=[...f.main.children],reader=dependency.render.mock.calls.at(-1)![0].props.children;
    const host=f.html.children.find(element=>element.shadow)!,theme=host.shadow!.children.find(element=>element.className==='theme')!;
    reader.props.onSelectRegion();f.dispatch('pointermove',{target:first.element});
    const click=f.dispatch('click',{target:first.element});await flush();
    expect(click.preventDefault).toHaveBeenCalledOnce();expect(click.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(theme.dataset.picking).toBeUndefined();expect(host.style.getPropertyValue('pointer-events')).toBe('auto');
    expect(theme.children.map(element=>element.className)).toEqual(['nc-session-mount']);
    expect(descendants(f.html).some(element=>element.className.startsWith('nc-session-region-'))).toBe(false);
    expect(f.main.children).toEqual(sourceElements);expect(f.targets.map(target=>target.element)).toEqual(sourceElements);
    expect(f.binds).toHaveLength(2);expect(f.binds[1].images).toEqual(f.binds[0].images);
    for(const type of ['pointermove','click','keydown'])expect(f.listeners(type)).toBe(0);
    for(const element of [f.html,f.body])expect(element.style.getPropertyValue('overflow')).toBe('hidden');
    f.stop();
  });

  it('cleans picker listeners, hints and the host when stopped while selection is active',async()=>{
    const f=fixture();f.add('first');await f.start();
    const reader=dependency.render.mock.calls.at(-1)![0].props.children;
    const host=f.html.children.find(element=>element.shadow)!,theme=host.shadow!.children.find(element=>element.className==='theme')!;
    reader.props.onSelectRegion();const picker=theme.children.filter(element=>element.className.startsWith('nc-session-region-'));
    expect(picker).toHaveLength(2);f.stop();
    expect(host.isConnected).toBe(false);expect(f.html.children).toEqual([f.body]);
    expect(picker.every(element=>!element.isConnected)).toBe(true);
    expect(theme.children.map(element=>element.className)).toEqual(['nc-session-mount']);
    for(const type of ['pointermove','click','keydown'])expect(f.listeners(type)).toBe(0);
    for(const element of [f.html,f.body])expect(element.style.getPropertyValue('overflow')).toBe('');
    expect(dependency.unmount).toHaveBeenCalledOnce();expect(f.main.children).toEqual([f.targets[0].element]);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });
});

describe('source position restoration',()=>{
  it('restores an externally toggled page inside the scroll container client edge, excluding its border',async()=>{
    const f=fixture();f.add('first');const second=f.add('second');await f.start();
    const reader=dependency.render.mock.calls.at(-1)![0].props.children;
    Object.assign(f.main,{top:220,clientTop:6,clientHeight:674,scrollHeight:5000,scrollTop:600});
    (second.element as unknown as FixtureElement).top=31;
    vi.stubGlobal('getComputedStyle',(element:Element)=>({overflowY:element===(f.main as unknown as Element)?'auto':'visible'}));
    reader.props.onPosition({pageId:reader.props.pages[1].id,relativeOffset:.25});f.stop();
    expect(f.main.scrollTop).toBe(600+31-220-6+1100*.25);
    expect(window.scrollBy).not.toHaveBeenCalled();expect(dependency.unmount).toHaveBeenCalledOnce();
  });

  it.each([
    {outerTop:300,outerOverflow:'hidden',innerTop:220,visibleTop:310},
    {outerTop:0,outerOverflow:'visible',innerTop:-100,visibleTop:0},
  ])('restores the same offset when an outer clip or the window raises the visible edge: %j',async({outerTop,outerOverflow,innerTop,visibleTop})=>{
    const f=fixture();f.add('first');const second=f.add('second');await f.start();
    const reader=dependency.render.mock.calls.at(-1)![0].props.children;
    Object.assign(f.main,{top:outerTop,clientTop:10,clientHeight:600});
    const inner=new FixtureElement(f.doc,'DIV',innerTop),image=second.element as unknown as FixtureElement;
    Object.assign(inner,{clientTop:6,clientHeight:450,scrollHeight:5000,scrollTop:600});
    f.main.children=f.main.children.filter(child=>child!==image);f.main.append(inner);inner.append(image);image.top=31;
    vi.stubGlobal('getComputedStyle',(element:Element)=>({overflowY:element===(inner as unknown as Element)?'auto'
      :element===(f.main as unknown as Element)?outerOverflow:'visible'}));
    reader.props.onPosition({pageId:reader.props.pages[1].id,relativeOffset:.25});f.stop();
    expect(inner.scrollTop).toBe(600+31-visibleTop+1100*.25);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });
});

describe('network chapter initial anchor',()=>{
  it('maps a visible duplicate URL element to its second network slot rather than the first URL match',async()=>{
    const sameUrl='https://images.example/shared.png';
    const images=[{id:'network-first',url:sameUrl,width:800,height:1100},{id:'network-second',url:sameUrl,width:800,height:1100}];
    const f=fixture({id:'network-session',navigationId,url,title:'Network chapter',direction:'rtl',complete:true,knownTotal:2,images,
      manifest:{adapter:'site',url,title:'Network chapter',direction:'rtl',discoveryComplete:true,knownTotal:2,note:'',
        items:images.map((image,order)=>({...image,order}))}});
    const first=f.add('first'),second=f.add('second');
    first.url=second.url=sameUrl;first.key=second.key=sameUrl;
    (first.element as unknown as FixtureElement).top=-1300;
    (second.element as unknown as FixtureElement).top=-200;
    await f.start();
    const reader=dependency.render.mock.calls.at(-1)![0].props.children;
    expect(reader.props.pages.map((page:ImmersiveImage)=>page.id)).toEqual(['network-first','network-second']);
    expect(reader.props.initialAnchor).toEqual({pageId:'network-second',relativeOffset:200/1100});
    f.stop();
  });
});

describe('current-tab source binding during generic rescans',()=>{
  it.each(['remove','prepend','reorder','resize'] as const)('refreshes unchanged page read identities after a source %s without remounting or losing the anchor',async(change)=>{
    const f=fixture();f.add('first');f.add('second');f.add('third');await f.start();
    const before=dependency.render.mock.calls.at(-1)![0].props.children;
    const position={pageId:before.props.pages[1].id,relativeOffset:.42};before.props.onPosition(position);
    f.replaceNextSession();
    if(change==='remove')f.targets.shift();
    else if(change==='prepend'){const inserted=f.add('inserted');f.targets.pop();f.targets.unshift(inserted);}
    else if(change==='reorder')f.targets.reverse();
    else (f.targets[0].element as unknown as FixtureElement).naturalHeight=1200;
    await f.change();
    const after=dependency.render.mock.calls.at(-1)![0].props.children;
    const previous=before.props.pages.find((page:ImmersiveImage)=>page.id===position.pageId);
    const current=after.props.pages.find((page:ImmersiveImage)=>page.id===position.pageId);
    expect(current.id).toBe(previous.id);expect(current.revision).not.toBe(previous.revision);
    expect(after.key).toBe(before.key);expect(after.props.initialAnchor).toEqual(position);
    expect(dependency.unmount).not.toHaveBeenCalled();expect(window.scrollBy).not.toHaveBeenCalled();f.stop();
  });

  it('keeps unchanged page read identities and the anchor for a same-session lazy append',async()=>{
    const f=fixture();f.add('first');f.add('second');await f.start();
    const before=dependency.render.mock.calls.at(-1)![0].props.children;
    const position={pageId:before.props.pages[1].id,relativeOffset:.42};before.props.onPosition(position);
    f.add('third');await f.change();const after=dependency.render.mock.calls.at(-1)![0].props.children;
    expect(after.props.pages.slice(0,2)).toEqual(before.props.pages);expect(after.key).toBe(before.key);
    expect(after.props.initialAnchor).toEqual(position);expect(dependency.unmount).not.toHaveBeenCalled();f.stop();
  });

  it.each(['rescan','reload'] as const)('does not automatically retry a failed %s binding on every scan interval',async(action)=>{
    const f=fixture();f.add('first');await f.start();await vi.advanceTimersByTimeAsync(120);
    const reader=dependency.render.mock.calls.at(-1)![0].props.children,binding=deferred<void>();
    f.delayNextBind(binding.promise);f.add('second');
    if(action==='rescan')await f.change();else{reader.props.onReload();await flush();}
    expect(f.binds).toHaveLength(2);
    binding.reject(Error('SOURCE_BIND_UNAVAILABLE'));await flush();await vi.advanceTimersByTimeAsync(2000);await flush();
    expect(f.binds).toHaveLength(2);expect(vi.getTimerCount()).toBe(0);f.stop();
  });

  it('rescans once after source changes during a delayed initial binding and then settles',async()=>{
    const f=fixture(),binding=deferred<void>();f.delayNextBind(binding.promise);
    await f.start();expect(f.binds[0].images).toHaveLength(0);
    const first=f.add('late-first');(first.element as unknown as FixtureElement).top=389;
    await f.change();expect(f.binds).toHaveLength(1);
    binding.resolve();await flush();await vi.advanceTimersByTimeAsync(120);await flush();
    expect(f.binds).toHaveLength(2);expect(f.binds[1].images).toHaveLength(1);
    const populated=dependency.render.mock.calls.at(-1)![0].props.children;
    expect(populated.props.initialAnchor).toEqual({pageId:f.binds[1].images[0].id,relativeOffset:0});
    await vi.advanceTimersByTimeAsync(240);await flush();
    expect(f.binds).toHaveLength(2);expect(vi.getTimerCount()).toBe(0);
    populated.props.onExit(populated.props.initialAnchor);expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('does not scroll the source on an unchanged exit after the first image arrives late',async()=>{
    const f=fixture();await f.start();
    const empty=dependency.render.mock.calls.at(-1)![0].props.children;
    expect(empty.props.pages).toHaveLength(0);
    const first=f.add('late-first');(first.element as unknown as FixtureElement).top=389;
    await f.change();
    const populated=dependency.render.mock.calls.at(-1)![0].props.children;
    expect(populated.key).not.toBe(empty.key);
    expect(populated.props.initialAnchor).toEqual({pageId:f.binds[1].images[0].id,relativeOffset:0});
    populated.props.onExit(populated.props.initialAnchor);
    expect(window.scrollBy).not.toHaveBeenCalled();expect(dependency.unmount).toHaveBeenCalledOnce();
  });

  it('initializes late content at the source viewport anchor and keeps subsequent appends mounted',async()=>{
    const f=fixture();await f.start();
    const empty=dependency.render.mock.calls.at(-1)![0].props.children;
    empty.props.onReadingWindow({pageIds:[],visiblePageIds:[],view:'translation',immediate:true});
    const first=f.add('first'),second=f.add('second');
    (first.element as unknown as FixtureElement).top=-1300;
    (second.element as unknown as FixtureElement).top=-200;
    await f.change();
    const populated=dependency.render.mock.calls.at(-1)![0].props.children;
    const position={pageId:f.binds[1].images[1].id,relativeOffset:200/1100};
    expect(populated.key).not.toBe(empty.key);
    expect(populated.props.initialAnchor).toEqual(position);expect(populated.props.initialView).toBe('translation');
    f.add('third');await f.change();
    const appended=dependency.render.mock.calls.at(-1)![0].props.children;
    expect(appended.props.pages).toHaveLength(3);expect(appended.key).toBe(populated.key);
    expect(appended.props.initialAnchor).toEqual(position);expect(appended.props.initialView).toBe('translation');
    appended.props.onExit(position);expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('keeps a deferred original read alive when a lazy append replaces only discovery wrappers',async()=>{
    const f=fixture(),pending=deferred<Blob>(),read=vi.fn(()=>pending.promise);
    f.add('first',read);f.add('second');await f.start();
    const original=f.sourcePort(f.binds[0].images[0].id);await flush();expect(read).toHaveBeenCalledOnce();
    f.add('third');await f.change();expect(f.binds[1].images.slice(0,2)).toEqual(f.binds[0].images);
    pending.resolve(new Blob(['original bytes'],{type:'image/png'}));await flush();
    expect(original.output).toEqual([{type:'image',size:14,mime:'image/png'}]);
    expect(original.port.disconnect).not.toHaveBeenCalled();expect(dependency.image).not.toHaveBeenCalled();f.stop();
  });

  it('continues acknowledged chunks across a lazy append without rereading the source',async()=>{
    const f=fixture(),read=vi.fn(async()=>new Blob([new Uint8Array(IMAGE_CHUNK_BYTES+3)],{type:'image/png'}));
    f.add('first',read);f.add('second');await f.start();
    const original=f.sourcePort(f.binds[0].images[0].id);await flush();
    original.pull(0);await flush();expect(original.output.at(-1)).toMatchObject({type:'chunk',offset:0});
    f.add('third');await f.change();original.pull(IMAGE_CHUNK_BYTES);await flush();
    expect(original.output.at(-1)).toEqual({type:'chunk',offset:IMAGE_CHUNK_BYTES,data:'AAAA'});
    expect(read).toHaveBeenCalledOnce();expect(original.port.disconnect).not.toHaveBeenCalled();f.stop();
  });

  it.each(['url','key','element'] as const)('rejects a deferred old source after its %s identity changes',async(field)=>{
    const f=fixture(),pending=deferred<Blob>(),first=f.add('first',()=>pending.promise);
    f.add('second');await f.start();const original=f.sourcePort(f.binds[0].images[0].id);await flush();
    if(field==='element'){
      const replacement=new FixtureElement(f.doc,'IMG');f.main.append(replacement);
      f.targets[0]={...first,element:replacement as unknown as HTMLImageElement};
    }else f.targets[0]={...first,[field]:field==='url'?'blob:'+url+'/replacement':'replacement-key'};
    await f.change();pending.resolve(new Blob(['stale bytes'],{type:'image/png'}));await flush();
    expect(original.output).toEqual([expect.objectContaining({type:'error'})]);
    expect(original.port.disconnect).toHaveBeenCalledOnce();f.stop();
  });

  it('rejects a source mutation even before a rescan can update the registered binding',async()=>{
    const f=fixture(),pending=deferred<Blob>(),first=f.add('first',()=>pending.promise);
    f.add('second');await f.start();const original=f.sourcePort(f.binds[0].images[0].id);await flush();
    first.key='new-live-key';pending.resolve(new Blob(['stale bytes'],{type:'image/png'}));await flush();
    expect(f.binds).toHaveLength(1);expect(original.output).toEqual([expect.objectContaining({type:'error'})]);f.stop();
  });
});
