import {createRoot,type Root} from 'react-dom/client';
import {IconSpriteContext} from '../icons';
import iconSprite from '../assets/icons.svg?raw';
import iconStyles from '../icons.css?raw';
import {msg,subscribeLocale} from '../i18n/runtime';
import {sourceDocument,pageImageReferrerPolicy,type PageImage} from '../sources/page';
import {sourceFor,sourceImage} from '../sources';
import type {SourceSnapshot} from '../sources/contracts/source';
import {sourceFailure} from '../sources/runtime/diagnostics';
import {defaults,type Settings} from '../types';
import {RequestPool} from '../concurrency';
import {randomId} from '../random-id';
import {bindWebShortcuts} from '../shortcuts/web-content';
import {SessionReader,sessionReaderStyles} from '../reader/SessionReader';
import type {SessionReaderAnchor,SessionReaderWindow,SessionReaderPage,SessionReaderProps} from '../reader/session-model';
import {shadowThemeStyles} from '../inline/shadow';
import {connectInlineTheme} from '../inline/theme';
import {receiveImage,serveImage} from '../inline/blob-transfer';
import {createImmersiveDiscovery,immersiveViewportTop,type ImmersiveSnapshot} from './discovery';
import {IMMERSIVE_ORIGINAL_PORT,IMMERSIVE_SOURCE_PORT,type ImmersiveImage,type ImmersiveSession,type ImmersiveResolve} from './protocol';
import {ImmersiveTranslation} from './translation';

export function installImmersive(){
  const lifecycle=sourceDocument(document),discovery=createImmersiveDiscovery(document);
  let enabled=false,dismissedUrl='',navigationId='',url='',epoch=0;
  let root:Root|undefined,host:HTMLElement|undefined,surface:HTMLElement|undefined;
  let releaseDocument:(()=>void)|undefined,releaseTheme:(()=>void)|undefined,releaseLocale:(()=>void)|undefined;
  let settings:Settings={...defaults},session:ImmersiveSession|undefined,translation:ImmersiveTranslation|undefined;
  let selectedRoot:Element|null=null,anchor:SessionReaderAnchor|undefined,entryAnchor:SessionReaderAnchor|undefined;
  let initialView:'original'|'translation'='original',lastWindow:SessionReaderWindow|undefined;
  let loading=false,error='',version=0,readerRevision=0,scanTimer:ReturnType<typeof setTimeout>|undefined;
  let signature='',picking=false,cancelPicker:(()=>void)|undefined;
  const pageSources=new Map<string,PageImage>(),originalLoads=new RequestPool(3),transfers=new Set<()=>void>();
  let focusBefore:HTMLElement|null=null;
  let locks:Array<{element:HTMLElement;value:string;priority:string;hadStyle:boolean}>=[];
  const current=(stamp=epoch)=>enabled&&epoch===stamp&&url===location.href&&lifecycle.current().navigationId===navigationId;
  const send=async<T,>(type:string,extra:Record<string,unknown>={}):Promise<T>=>{
    const response=await chrome.runtime.sendMessage({type,navigationId,...extra});
    if(!response?.ok)throw Error(response?.error??msg('插件通信失败，请重新打开阅读器。'));
    return response.data as T;
  };
  const imagePayload=(image:ImmersiveImage)=>({...image,url:'page-image:'+image.id,width:Math.max(1,image.width),height:Math.max(1,image.height)});
  function updateWindow(value:SessionReaderWindow){
    lastWindow=value;if(!session)return;
    if(host)host.dataset.view=value.view;
    translation?.update(value,value.pageIds.flatMap(id=>{const image=session!.images.find(item=>item.id===id);return image?[imagePayload(image)]:[];}));
  }
  function lockPage(){
    for(const element of [document.documentElement,document.body]){
      if(!element)continue;locks.push({element,value:element.style.getPropertyValue('overflow'),priority:element.style.getPropertyPriority('overflow'),hadStyle:element.hasAttribute('style')});
      element.style.setProperty('overflow','hidden','important');
    }
  }
  function unlockPage(){
    for(const {element,value,priority,hadStyle} of locks)if(element.style.getPropertyValue('overflow')==='hidden'&&element.style.getPropertyPriority('overflow')==='important'){
      if(value)element.style.setProperty('overflow',value,priority);else element.style.removeProperty('overflow');
      // Synchronize a pending CSSOM attribute before removing it on a fast loading cancellation.
      if(!hadStyle&&!element.style.length&&element.hasAttribute('style'))element.removeAttribute('style');
    }
    locks=[];
  }
  function restorePosition(position?:SessionReaderAnchor){
    if(url!==location.href)return;
    const moved=position&&(!entryAnchor||entryAnchor.pageId!==position.pageId||Math.abs(entryAnchor.relativeOffset-position.relativeOffset)>.02);
    const target=moved?pageSources.get(position.pageId)?.element:undefined;
    if(target?.isConnected){
      const rect=target.getBoundingClientRect();
      let container=target.parentElement;
      while(container&&container!==document.body&&container!==document.documentElement){
        const style=getComputedStyle(container);
        if(/auto|scroll/.test(style.overflowY)&&container.scrollHeight>container.clientHeight){
          container.scrollTop+=rect.top-immersiveViewportTop(target,document)+rect.height*position!.relativeOffset;break;
        }
        container=container.parentElement;
      }
      if(!container||container===document.body||container===document.documentElement)window.scrollBy(0,rect.top+rect.height*position!.relativeOffset);
    }
    if(focusBefore?.isConnected)focusBefore.focus({preventScroll:true});
  }
  function stop(position?:SessionReaderAnchor){
    if(!enabled)return;
    dismissedUrl=url;enabled=false;loading=false;epoch++;version++;
    cancelPicker?.();picking=false;clearTimeout(scanTimer);scanTimer=undefined;
    translation?.dispose();translation=undefined;
    for(const close of transfers)close();
    root?.unmount();root=undefined;host?.remove();host=undefined;
    unlockPage();restorePosition(position);focusBefore=null;
    releaseTheme?.();releaseLocale?.();releaseTheme=releaseLocale=undefined;
    releaseDocument?.();releaseDocument=undefined;
    void send('NC_IMMERSIVE_RELEASE').catch(()=>{});
    session=undefined;pageSources.clear();discovery.reset();lastWindow=undefined;
  }
  function render(){
    if(!enabled||!root||!host)return;
    host.dataset.loading=String(loading);host.dataset.error=error;host.dataset.pageCount=String(session?.images.length??0);host.dataset.complete=String(session?.complete??false);
    if(!session){
      root.render(<div className="nc-app nc-session-reader" onKeyDown={event=>{
        event.stopPropagation();if(event.nativeEvent.isComposing||event.keyCode===229)return;
        if(event.key==='Escape'){event.preventDefault();stop();return;}
        if(event.key==='Tab'){
          const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
          const active=(event.currentTarget.getRootNode() as ShadowRoot).activeElement;
          if(event.shiftKey&&(active===buttons[0]||!buttons.includes(active as HTMLButtonElement))||!event.shiftKey&&active===buttons.at(-1)){
            event.preventDefault();(event.shiftKey?buttons.at(-1):buttons[0])?.focus();
          }
        }
      }}><div className="nc-session-start" ref={bindStartShortcuts} tabIndex={-1} role="dialog" aria-modal="true" aria-label={msg('沉浸阅读')} aria-busy={loading}>
        <button className="button secondary nc-session-start-back" onClick={()=>stop()}>{msg('返回网页')}</button>
        <div className="nc-session-start-state" role={error?'alert':'status'} aria-atomic="true">
          {loading&&<span className="spinner" aria-hidden="true"/>}
          <h2>{msg('沉浸阅读')}</h2><p>{error||msg('正在准备页面…')}</p>
          {!loading&&<div className="nc-session-start-actions"><button className="button secondary" onClick={()=>void resolve()}>{msg('重试')}</button><button className="button secondary" onClick={selectRegion}>{msg('选择正文区域')}</button></div>}
        </div>
      </div></div>);return;
    }
    const pages:SessionReaderPage[]=session.images.map(image=>{
      const result=translation?.results.get(image.id);
      return {...image,revision:result?.resultKey??'original',status:result?.state};
    });
    const source=sourceFor(url);
    root.render(<IconSpriteContext value=""><SessionReader key={readerRevision} title={session.title} pages={pages} settings={settings} setSettings={change=>{
      settings=typeof change==='function'?change(settings):change;render();void send('NC_IMMERSIVE_SETTINGS',{settings}).catch(()=>{});
    }} initialView={initialView} initialAnchor={anchor} complete={session.complete} loading={loading}
      notice={error||(!session.complete?msg('已识别 {0} 张，可能不完整。',{'0':session.images.length}):undefined)}
      loadImage={loadImage} onExit={position=>stop(position)} onPosition={position=>{
        anchor=position;if(host)host.dataset.currentPage=String(Math.max(0,session!.images.findIndex(image=>image.id===position.pageId))+1);
      }} onReadingWindow={updateWindow} onRetry={id=>{
        const state=translation?.results.get(id)?.state;
        if(state?.kind==='login'||state?.kind==='upgrade'){translation?.openAccount();return;}
        translation?.retry(id);
      }} onReload={()=>void resolve()} onSelectRegion={!session.manifest?selectRegion:undefined}
      onImport={source.definition.capabilities.importable&&source.location.kind!=='other'?()=>{void send('NC_IMPORT_CURRENT').catch(reason=>{error=sourceFailure(reason).error;render();});}:undefined}/></IconSpriteContext>);
  }
  const bindStartShortcuts=(node:HTMLDivElement|null)=>{
    if(!node)return;
    node.focus({preventScroll:true});
    return bindWebShortcuts({'web.immersive':()=>stop()},()=>enabled&&!picking,node);
  };
  const loadImage:SessionReaderProps['loadImage']=async(id,view,signal)=>{
    try{
    const stamp=epoch,sessionId=session?.id,image=session?.images.find(item=>item.id===id);
    if(!image)throw Error('SOURCE_RESOURCE_EXPIRED');
    if(view==='translation'){
      const blob=await translation?.read(imagePayload(image),signal);
      if(blob)return {blob,release(){},translated:true};
    }
    const blob=await originalLoads.run(async()=>{
      signal.throwIfAborted();if(!current(stamp)||session?.id!==sessionId)throw Error('SOURCE_SESSION_EXPIRED');
      return receiveImage(chrome.runtime.connect({name:IMMERSIVE_ORIGINAL_PORT}),{navigationId,id},signal,()=>current(stamp)&&session?.id===sessionId);
    });
    return {blob,release(){},translated:false};
    }catch(reason){throw Error(sourceFailure(reason).error);}
  };
  function describePages(snapshot:ImmersiveSnapshot){
    return snapshot.pages.map(page=>({id:page.id,url:/^(blob:|data:|page-image:)/.test(page.url)?'page-image:'+page.id:page.url,
      width:page.width,height:page.height,referrerPolicy:pageImageReferrerPolicy(page.element)}));
  }
  function sourceMatcher(targets:readonly PageImage[]){
    const matches=new Map<string,PageImage[]>();
    for(const target of [...targets].reverse()){
      const list=matches.get(target.url)??[];list.push(target);matches.set(target.url,list);
    }
    return (url:string)=>matches.get(url)?.pop();
  }
  async function bindDocument(stamp:number,request:number,snapshot=discovery.scan(selectedRoot)){
    const images:ImmersiveImage[]=describePages(snapshot);
    const nextSources=new Map<string,PageImage>(snapshot.pages.map(page=>[page.id,page]));
    const definition=sourceFor(url).definition;
    let full:SourceSnapshot|undefined;
    if(!selectedRoot&&definition.inlineRecognition!=='generic'&&definition.id!=='generic'){
      const found=await lifecycle.current().session.discoverPages();
      if(found.status==='ready')full=found.value;
      else if(found.status==='error')throw Error(found.code);
    }
    if(!current(stamp)||request!==version)return;
    if(full?.items.length){
      const targetFor=sourceMatcher(lifecycle.current().session.inlineTargets());images.length=0;nextSources.clear();
      for(const page of full.items){
        const id=randomId(),resource=page.resource;
        if(resource.kind==='page'){
          const target=targetFor(resource.resourceKey);if(!target?.read)throw Error('SOURCE_RESOURCE_EXPIRED');
          nextSources.set(id,target);
        }else{const target=targetFor(resource.url);if(target)nextSources.set(id,target);}
        images.push({id,url:resource.kind==='http'?resource.url:'page-image:'+id,width:page.width,height:page.height,referrerPolicy:undefined});
      }
    }
    if(!current(stamp)||request!==version)return;
    const value=await send<ImmersiveSession>('NC_IMMERSIVE_BIND',{images,snapshot:full,title:snapshot.title,direction:snapshot.direction});
    if(!current(stamp)||request!==version)return;
    session=value;signature=JSON.stringify(images);
    pageSources.clear();for(const [id,target] of nextSources)pageSources.set(id,target);
    if(!anchor&&snapshot.anchor){
      const target=snapshot.pages.find(page=>page.id===snapshot.anchor!.id);
      const image=images.find(image=>image.id===snapshot.anchor!.id)||(target&&images.find(image=>nextSources.get(image.id)?.element===target.element));
      if(image)anchor={pageId:image.id,relativeOffset:snapshot.anchor.offset};
    }
  }
  async function resolve(resetPosition=false){
    if(!enabled||loading&&!resetPosition)return;
    const previous=session,position=anchor;
    if(lastWindow)initialView=lastWindow.view;
    const stamp=epoch,request=++version;let resolved=false;loading=true;error='';
    translation?.update({pageIds:[],visiblePageIds:[],view:'original',immediate:true},[]);render();
    try{
      const snapshot=discovery.scan(selectedRoot);
      const result=selectedRoot?{settings}:await send<ImmersiveResolve>('NC_IMMERSIVE_RESOLVE');
      if(!current(stamp)||request!==version)return;
      settings={...result.settings,direction:result.session?.direction??snapshot.direction};
      if(result.session){
        session=result.session;pageSources.clear();
        const targetFor=sourceMatcher(snapshot.pages);
        for(const image of session.images){const target=targetFor(image.url);if(target)pageSources.set(image.id,target);}
        if(snapshot.anchor){
          const target=snapshot.pages.find(page=>page.id===snapshot.anchor!.id),image=target&&session.images.find(image=>pageSources.get(image.id)?.element===target.element);
          if(image)anchor={pageId:image.id,relativeOffset:snapshot.anchor.offset};
        }
      }else await bindDocument(stamp,request,snapshot);
      if(!current(stamp)||request!==version)return;
      if(previous&&session&&!resetPosition){
        const remap=(value:SessionReaderAnchor|undefined)=>{
          if(!value)return;
          const index=previous.images.findIndex(image=>image.id===value.pageId);if(index<0)return;
          const sourceId=previous.manifest?.items[index]?.id;
          const found=sourceId?session!.manifest?.items.findIndex(page=>page.id===sourceId):session!.images.findIndex(image=>image.id===value.pageId);
          const next=session!.images[found!=null&&found>=0?found:Math.min(index,session!.images.length-1)];
          return next?{pageId:next.id,relativeOffset:value.relativeOffset}:undefined;
        };
        anchor=remap(position)??anchor;entryAnchor=remap(entryAnchor);
      }
      translation?.dispose();translation=new ImmersiveTranslation(navigationId,render);
      if(resetPosition)entryAnchor=undefined;
      entryAnchor??=anchor??(session?.images[0]?{pageId:session.images[0].id,relativeOffset:0}:undefined);
      readerRevision++;resolved=true;
    }catch(reason){if(current(stamp)&&request===version){error=sourceFailure(reason).error;if(lastWindow)updateWindow(lastWindow);}}
    finally{if(current(stamp)&&request===version){loading=false;render();if(resolved)queueScan();}}
  }
  function queueScan(){
    if(!enabled||loading||session?.manifest||document.hidden||picking||scanTimer)return;
    scanTimer=setTimeout(()=>{
      scanTimer=undefined;if(!enabled||loading||picking||document.hidden||!session||session.manifest)return;
      const next=discovery.scan(selectedRoot),images=describePages(next);
      if(JSON.stringify(images)===signature)return;
      const wasEmpty=!session.images.length,stamp=epoch,request=++version;let bound=false;loading=true;
      void bindDocument(stamp,request,next).then(()=>{if(current(stamp)&&request===version){
        if(wasEmpty&&session?.images.length){
          entryAnchor=anchor??{pageId:session.images[0].id,relativeOffset:0};
          if(lastWindow)initialView=lastWindow.view;
          readerRevision++;
        }
        bound=true;if(lastWindow)updateWindow(lastWindow);
      }})
        .catch(reason=>{if(current(stamp)&&request===version)error=sourceFailure(reason).error;})
        .finally(()=>{if(current(stamp)&&request===version){loading=false;render();if(bound)queueScan();}});
    },120);
  }
  function selectRegion(){
    if(!enabled||picking)return;
    const focused=(surface!.getRootNode() as ShadowRoot).activeElement;
    picking=true;surface!.dataset.picking='true';host!.style.setProperty('pointer-events','none','important');unlockPage();
    translation?.update({pageIds:[],visiblePageIds:[],view:'original',immediate:true},[]);
    const hint=document.createElement('div');hint.className='nc-session-region-hint';hint.textContent=msg('点击漫画正文区域，Esc 取消。');
    const highlight=document.createElement('div');highlight.className='nc-session-region-highlight';highlight.style.display='none';
    surface!.append(hint,highlight);let chosen:Element|null=null;
    const move=(event:PointerEvent)=>{chosen=event.target instanceof Element?discovery.rootFor(event.target):null;
      if(chosen){const rect=chosen.getBoundingClientRect();Object.assign(highlight.style,{display:'block',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});}else highlight.style.display='none';};
    const done=()=>{document.removeEventListener('pointermove',move,true);document.removeEventListener('click',click,true);document.removeEventListener('keydown',key,true);hint.remove();highlight.remove();picking=false;cancelPicker=undefined;if(enabled){delete surface!.dataset.picking;host!.style.setProperty('pointer-events','auto','important');lockPage();if(focused instanceof HTMLElement&&focused.isConnected)focused.focus({preventScroll:true});}};
    const click=(event:MouseEvent)=>{event.preventDefault();event.stopImmediatePropagation();if(!chosen&&event.target instanceof Element)chosen=discovery.rootFor(event.target);if(!chosen)return;selectedRoot=chosen;anchor=undefined;done();void resolve(true);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();done();if(lastWindow)updateWindow(lastWindow);}};
    cancelPicker=done;document.addEventListener('pointermove',move,true);document.addEventListener('click',click,true);document.addEventListener('keydown',key,true);
  }
  function prepare(translated:boolean){
    if(enabled&&url===location.href)return;
    stop();enabled=true;dismissedUrl='';epoch++;url=location.href;navigationId=lifecycle.current().navigationId;initialView=translated?'translation':'original';
    anchor=entryAnchor=undefined;selectedRoot=null;signature='';focusBefore=document.activeElement instanceof HTMLElement?document.activeElement:null;
    releaseDocument=lifecycle.subscribe({changed:queueScan,invalidated:()=>stop()});
  }
  function show(){
    if(host)return;
    host=document.createElement('div');host.dataset.ncImmersive='';host.dataset.currentPage='1';host.dataset.view=initialView;
    host.style.cssText='all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;pointer-events:auto!important;color-scheme:normal!important';
    const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');style.textContent=shadowThemeStyles(iconStyles+'\n'+sessionReaderStyles);
    const sprite=new DOMParser().parseFromString(iconSprite,'image/svg+xml').documentElement;
    sprite.setAttribute('style','position:absolute;width:0;height:0;overflow:hidden');sprite.setAttribute('aria-hidden','true');shadow.append(document.importNode(sprite,true));
    surface=document.createElement('div');surface.className='theme';surface.style.cssText='height:100%;width:100%;';shadow.append(style,surface);
    const mount=document.createElement('div');mount.className='nc-session-mount';surface.append(mount);
    document.documentElement.append(host);root=createRoot(mount);releaseTheme=connectInlineTheme(surface);releaseLocale=subscribeLocale(render);lockPage();void resolve();
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id)return;
    if(message?.type==='NC_IMMERSIVE_IDENTITY'){respond({url:location.href,navigationId:lifecycle.current().navigationId,enabled,dismissedUrl});return;}
    if(message?.type==='NC_IMMERSIVE_PREPARE'){prepare(message.translation===true);respond({ok:true});return;}
    if(message?.type==='NC_IMMERSIVE_SHOW'){show();respond({ok:true});return;}
    if(message?.type==='NC_IMMERSIVE_STOP'){stop(anchor);respond({ok:true});return;}
    if(enabled)translation?.onMessage(message);
  });
  chrome.runtime.onConnect.addListener(port=>{
    if(port.name!==IMMERSIVE_SOURCE_PORT)return;
    if(port.sender?.id!==chrome.runtime.id||!port.sender.url?.startsWith(chrome.runtime.getURL(''))||transfers.size>=3){port.disconnect();return;}
    const close=serveImage(port,async(value,signal)=>{
      const request=value as {navigationId:string;id:string},stamp=epoch,target=pageSources.get(request.id);
      if(!current(stamp)||request.navigationId!==navigationId||!target)throw Error('SOURCE_RESOURCE_EXPIRED');
      const {element,key,url:sourceUrl}=target;
      const validate=()=>{const bound=pageSources.get(request.id);return current(stamp)&&bound?.element===element&&bound.key===key&&bound.url===sourceUrl&&element.isConnected&&lifecycle.current().session.inlineTargets().some(item=>item.element===element&&item.url===sourceUrl&&item.key===key);};
      if(!validate())throw Error('SOURCE_RESOURCE_EXPIRED');
      const blob=await (target.read?target.read(signal):sourceImage(target.url,signal));
      return {blob,current:()=>!signal.aborted&&validate()};
    },()=>transfers.delete(close));transfers.add(close);
  });
  document.addEventListener('visibilitychange',()=>{if(enabled&&lastWindow){updateWindow(lastWindow);if(!document.hidden)queueScan();}});
  window.addEventListener('online',()=>{if(enabled)translation?.reset();});
}
