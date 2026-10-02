import {msg,subscribeLocale} from '../i18n/runtime';
import {receiveImage} from '../inline/blob-transfer';
import {shadowThemeStyles} from '../inline/shadow';
import {connectInlineTheme} from '../inline/theme';
import {translationNotice} from '../translation/notice';
import type {TranslationState} from '../translation/automatic';
import {capturePlacement,imagePlacementValid,placementBox,RegionDisplay,type RegionPlacement} from './display';
import {REGION_IMAGE_PORT,type RegionIdentity,type RegionImageRequest,type RegionRect,type RegionRequest,type RegionResponse,type RegionViewport} from './protocol';
import styles from './styles.css?inline';
import {bindWebShortcuts} from '../shortcuts/web-content';

const viewport=():RegionViewport=>({width:innerWidth,height:innerHeight,devicePixelRatio,scrollX,scrollY,...(visualViewport?{visualViewport:{width:visualViewport.width,height:visualViewport.height,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale}}:{})});
const twoFrames=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
const selection=(a:{x:number;y:number},b:{x:number;y:number}):RegionRect=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)});

/** Page-wide keys may cancel, but never initiate a screenshot or translation. */
export function handleRegionKey(event:Pick<KeyboardEvent,'key'|'isTrusted'|'preventDefault'|'stopPropagation'>,close:()=>void){
  if(!event.isTrusted||event.key!=='Escape')return;
  event.preventDefault();event.stopPropagation();close();
}
export const cancelsRegionDrag=(event:Pick<MouseEvent,'button'|'isTrusted'>&Partial<Pick<MouseEvent,'buttons'>>,selecting:boolean)=>
  selecting&&event.isTrusted&&(event.button===2||((event.buttons??0)&2)!==0);

export function installRegion(){
  let initialUrl=location.href,navigationId=crypto.randomUUID(),generation=0,selectionId:string|undefined;
  let enabled=false,dismissedUrl='',phase:'selecting'|'capturing'|'ready'='selecting';
  let rect:RegionRect|undefined,placement:RegionPlacement|undefined,invalidPlacement=false,original=false,previewOpen=false;
  let state:TranslationState|undefined,loadError:TranslationState|undefined,sourceUrl:string|undefined,resultUrl:string|undefined,resultKey:string|undefined;
  let sourceLoad:AbortController|undefined,sourceError:string|undefined;
  let retryRequest:'NC_REGION_SUBMIT'|'NC_REGION_TICK'|undefined;
  let submitted=false,submitIntent=false,hasPending=false,retryAfterMs=0,requiresInternet=false;
  let resultLoad:object|undefined;
  let drag:{x:number;y:number;pointerId:number}|undefined,activity=0,running:object|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined,navigationTimer:ReturnType<typeof setInterval>|undefined,raf=0;
  let cancelMenuCleanup:(()=>void)|undefined;
  const transfers=new Set<AbortController>();
  const host=document.createElement('div');host.dataset.ncRegion='';
  host.style.cssText='all:initial!important;position:fixed!important;inset:0!important;overflow:hidden!important;z-index:2147483646!important;pointer-events:none!important';
  const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');style.textContent=shadowThemeStyles(styles);shadow.append(style);
  const surface=document.createElement('div');surface.className='theme';shadow.append(surface);connectInlineTheme(surface);
  const display=new RegionDisplay(surface),mask=document.createElement('div'),outline=document.createElement('div');
  mask.className='selector';mask.tabIndex=-1;outline.className='selection';outline.hidden=true;surface.append(mask,outline);
  const bar=document.createElement('div');bar.className='bar';bar.setAttribute('role','region');
  const label=document.createElement('span');label.className='label';bar.append(label);
  const status=document.createElement('span');status.className='status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');bar.append(status);
  const button=(action:()=>void)=>{const element=document.createElement('button');element.type='button';element.onclick=action;bar.append(element);return element;};
  const retry=button(()=>{
    const actionState=loadError??state;
    if(actionState?.kind==='login'||actionState?.kind==='upgrade'){void send('NC_REGION_OPEN',{view:'account'}).catch(()=>{});return;}
    if(loadError&&loadError.retryAction!=='translate'&&resultKey){void loadResult(resultKey);return;}
    if(actionState?.retryAction!=='translate'&&retryRequest){void progress(retryRequest);return;}
    loadError=undefined;
    state={kind:'translating',message:msg('重试中…')};paint();void progress('NC_REGION_RETRY');
  });
  const toggleOriginal=()=>{if(!resultUrl)return false;original=!original;paint();};
  const originals=button(toggleOriginal);
  const previews=button(()=>{
    previewOpen=!previewOpen;
    if(!previewOpen){cancelSource();sourceError=undefined;}
    paint();
  });
  const reselect=button(()=>beginSelection());
  const settings=button(()=>{void send('NC_REGION_OPEN',{view:'settings'}).catch(()=>{});});
  const close=button(()=>stop(true,true));surface.append(bar);
  bindWebShortcuts({'web.original':toggleOriginal,'web.close':()=>stop(true,true)},
    ()=>enabled&&initialUrl===location.href);
  const preview=document.createElement('section');preview.className='preview';preview.setAttribute('role','region');
  const previewTitle=document.createElement('h2'),previewImage=document.createElement('img'),notice=document.createElement('p');notice.className='notice';
  const previewRetry=document.createElement('button');previewRetry.type='button';
  previewRetry.onclick=()=>{sourceError=undefined;void loadSource();};
  preview.append(previewTitle,previewImage,notice,previewRetry);surface.append(preview);
  const identity=():RegionIdentity=>({url:location.href,navigationId,enabled,dismissedUrl,generation,selectionId,viewport:viewport()});
  const snapshot=()=>({navigationId,generation,selectionId});
  const same=(value:ReturnType<typeof snapshot>)=>enabled&&location.href===initialUrl&&value.navigationId===navigationId&&value.generation===generation&&value.selectionId===selectionId;
  async function send(type:RegionRequest['type'],extra:Partial<RegionRequest>={}){
    const response=await chrome.runtime.sendMessage({type,...snapshot(),...extra} satisfies RegionRequest) as {ok:boolean;data?:RegionResponse;error?:string};
    if(!response?.ok)throw Error(response?.error??msg('连接失败'));
    return response.data;
  }
  function clearResources(){
    sizeObserver.disconnect();
    cancelSource();sourceError=undefined;
    for(const controller of transfers)controller.abort();transfers.clear();display.clear();
    if(sourceUrl)URL.revokeObjectURL(sourceUrl);if(resultUrl)URL.revokeObjectURL(resultUrl);
    sourceUrl=undefined;resultUrl=undefined;resultKey=undefined;previewImage.removeAttribute('src');
    resultLoad=undefined;loadError=undefined;
  }
  function pause(){
    clearTimeout(timer);timer=undefined;activity++;running=undefined;
    void send('NC_REGION_PAUSE').catch(()=>{});
    cancelSource();
    for(const controller of transfers)controller.abort();transfers.clear();resultLoad=undefined;
  }
  function beginSelection(){
    if(!enabled)return;
    if(selectionId)void send('NC_REGION_CLOSE').catch(()=>{});
    pause();generation++;selectionId=crypto.randomUUID();clearResources();rect=undefined;placement=undefined;invalidPlacement=false;
    phase='selecting';state=undefined;retryRequest=undefined;submitted=false;submitIntent=false;hasPending=false;retryAfterMs=0;original=false;previewOpen=false;drag=undefined;
    host.style.removeProperty('visibility');outline.hidden=true;paint();mask.focus({preventScroll:true});
  }
  function invalidateCapture(){
    if(phase!=='capturing')return;
    beginSelection();state={kind:'error',message:msg('当前页面已变化，请重新框选。'),retryable:false};paint();
  }
  function markChanged(){
    if(phase==='capturing'){invalidateCapture();return;}
    if(!rect||phase==='selecting'||invalidPlacement)return;
    invalidPlacement=true;
    if(resultUrl&&placement?.kind!=='preview')previewOpen=true;
    paint();
  }
  function paint(){
    // Read geometry before updating the controls. A temporarily hidden crop can
    // return after scrolling; a different source or size must never reuse it.
    const position=!invalidPlacement&&placement?placementBox(placement,host):undefined;
    if(!position&&!invalidPlacement&&placement?.kind==='image'&&!imagePlacementValid(placement)){
      invalidPlacement=true;if(resultUrl)previewOpen=true;
    }
    bar.setAttribute('aria-label',msg('划图翻译'));mask.setAttribute('aria-label',msg('拖动框选，松手翻译；右键或 Esc 取消。'));
    mask.hidden=phase!=='selecting';outline.hidden=phase!=='selecting'||!drag||!rect;
    label.textContent=phase==='selecting'?msg('拖动框选，松手翻译；右键或 Esc 取消。'):phase==='capturing'?msg('正在截取选区…'):msg('划图翻译');
    const loadingResult=!!resultLoad;
    const currentState=loadingResult?{kind:'translating' as const,message:msg('正在读取译图')}:loadError??state;
    const message=currentState?translationNotice(currentState):undefined;
    status.textContent=message?.message??(resultKey?msg('翻译完成'):'');status.title=message?.detail??'';status.dataset.kind=currentState?.kind??'';
    const actionable=!!currentState&&(currentState.kind==='login'||currentState.kind==='upgrade'||currentState.kind==='error'&&currentState.retryable!==false);
    retry.hidden=!actionable;retry.textContent=message?.label??'';retry.title=message?.detail??'';retry.disabled=!!running||loadingResult||document.hidden;
    originals.hidden=!resultUrl;originals.textContent=original?msg('显示译图'):msg('恢复原图');
    previews.hidden=phase!=='ready';previews.textContent=previewOpen?msg('关闭预览'):msg('显示预览');
    reselect.textContent=msg('重新框选');reselect.hidden=phase==='selecting';settings.textContent=msg('设置');close.textContent=msg('关闭');
    const wantsSource=previewOpen&&(original||!resultUrl);
    if(!wantsSource||document.hidden)cancelSource();
    const source=original||!resultUrl?sourceUrl:resultUrl,title=source===resultUrl&&resultUrl?msg('译图预览'):msg('截图预览');
    preview.hidden=!previewOpen||phase!=='ready';previewTitle.textContent=title;preview.setAttribute('aria-label',title);previewImage.alt=title;previewImage.hidden=!source;
    if(previewOpen&&!document.hidden&&source){if(previewImage.getAttribute('src')!==source)previewImage.src=source;}
    else previewImage.removeAttribute('src');
    notice.textContent=wantsSource&&!sourceUrl?(sourceError??msg('加载中…')):invalidPlacement?msg('页面已变化，译图仅在预览中显示。'):placement?.kind==='preview'?msg('此区域无法可靠定位，译图将在预览中显示。'):'';notice.hidden=!notice.textContent;
    previewRetry.hidden=!wantsSource||!sourceError;previewRetry.disabled=!!sourceLoad||document.hidden;previewRetry.textContent=msg('点击重新加载');
    display.paint(position,enabled&&!original&&!document.hidden);
    const pending=phase==='capturing'||loadingResult||((submitted||submitIntent)&&(!!running||hasPending||state?.kind==='waiting'||state?.kind==='translating'));
    const failed=!!currentState&&['error','login','upgrade'].includes(currentState.kind);
    display.paintLoading(!invalidPlacement&&placement?.kind==='preview'?rect:position,enabled&&!document.hidden&&pending&&!failed);
    if(wantsSource&&!sourceUrl&&!sourceLoad&&!sourceError&&!document.hidden)void loadSource();
  }
  function schedule(delay=0,wait=false){
    clearTimeout(timer);timer=undefined;
    if(!enabled||!submitted&&!submitIntent||document.hidden||requiresInternet&&navigator.onLine===false)return;
    timer=setTimeout(()=>void progress(wait?'NC_REGION_WAIT':'NC_REGION_TICK'),Math.max(0,delay));
  }
  async function image(kind:'source'|'result',key?:string,controller=new AbortController()){
    const value=snapshot();if(!value.selectionId)throw Error(msg('截图未能读取，请重新框选。'));
    transfers.add(controller);
    try{return await receiveImage(chrome.runtime.connect({name:REGION_IMAGE_PORT}),{...value,selectionId:value.selectionId,kind,...(key?{resultKey:key}:{})} satisfies RegionImageRequest,controller.signal,()=>same(value)&&!document.hidden);}
    finally{transfers.delete(controller);}
  }
  function cancelSource(){
    const pending=sourceLoad;sourceLoad=undefined;pending?.abort();
  }
  async function loadSource(){
    if(!enabled||phase!=='ready'||!previewOpen||document.hidden||sourceUrl||sourceLoad||!original&&!!resultUrl)return;
    const value=snapshot(),controller=new AbortController();sourceLoad=controller;sourceError=undefined;paint();
    const current=()=>same(value)&&sourceLoad===controller&&!controller.signal.aborted&&previewOpen&&!document.hidden&&(original||!resultUrl);
    try{
      const blob=await image('source',undefined,controller);
      if(current())sourceUrl=URL.createObjectURL(blob);
    }catch(error){if(current())sourceError=(error as Error).message||msg('截图未能读取，请重新框选。');}
    finally{if(same(value)&&sourceLoad===controller){sourceLoad=undefined;paint();}}
  }
  async function loadResult(key:string){
    if(resultLoad||!enabled||document.hidden)return;
    const value=snapshot(),operation={};resultLoad=operation;loadError=undefined;paint();
    const current=()=>same(value)&&resultLoad===operation&&resultKey===key&&!document.hidden;
    try{
      const blob=await image('result',key);if(!current())return;
      await display.show(blob,key,current);
      if(!current())return;
      if(resultUrl)URL.revokeObjectURL(resultUrl);resultUrl=URL.createObjectURL(blob);state=undefined;
      previewOpen=previewOpen||invalidPlacement||placement?.kind==='preview';
    }catch(error){
      if(current())loadError={kind:'error',message:(error as Error).message,
        retryAction:(error as {code?:string}).code==='RESULT_NOT_CACHED'?'translate':undefined,retryLabel:msg('点击重新加载')};
    }
    finally{if(same(value)&&resultLoad===operation){resultLoad=undefined;paint();if(resultKey&&resultKey!==key&&!loadError&&!document.hidden)void loadResult(resultKey);}}
  }
  function apply(data:RegionResponse){
    if(data.selectionId!==selectionId)return;
    state=data.state;submitted=data.submitted;submitIntent=data.submitted;hasPending=!!data.hasPending;retryAfterMs=data.retryAfterMs??0;requiresInternet=!!data.requiresInternet;
    if(data.resultKey!==resultKey){resultKey=data.resultKey;loadError=undefined;if(!resultKey){display.clear();if(resultUrl)URL.revokeObjectURL(resultUrl);resultUrl=undefined;}}
    if(resultKey&&display.key!==resultKey&&!loadError)void loadResult(resultKey);
    paint();
  }
  async function progress(type:'NC_REGION_SUBMIT'|'NC_REGION_TICK'|'NC_REGION_WAIT'|'NC_REGION_RETRY'){
    if(!enabled||!selectionId||running||document.hidden||phase!=='ready')return;
    if(!submitted&&!submitIntent&&type!=='NC_REGION_SUBMIT'&&type!=='NC_REGION_RETRY')return;
    const value=snapshot(),stamp=activity,operation={};running=operation;retryRequest=undefined;clearTimeout(timer);
    if(type==='NC_REGION_SUBMIT'){submitIntent=true;state={kind:'translating',message:msg('正在连接翻译服务')};}paint();
    try{const data=await send(type);if(same(value)&&stamp===activity&&data&&!document.hidden)apply(data);}
    catch(error){if(same(value)&&stamp===activity&&!document.hidden){hasPending=false;retryRequest=type==='NC_REGION_SUBMIT'&&!submitted?'NC_REGION_SUBMIT':'NC_REGION_TICK';state={kind:'error',message:(error as Error).message};paint();}}
    finally{
      if(running===operation)running=undefined;
      if(same(value)&&stamp===activity){paint();if(!document.hidden&&hasPending)schedule(retryAfterMs,!!hasPending&&!retryAfterMs);}
    }
  }
  async function capture(selected:RegionRect){
    const value=snapshot();rect=selected;placement=capturePlacement(selected,host);invalidPlacement=false;phase='capturing';drag=undefined;
    state=undefined;paint();host.style.setProperty('visibility','hidden','important');
    try{
      await twoFrames();if(!same(value)||document.hidden)return;
      const data=await send('NC_REGION_CAPTURE',{rect:selected,viewport:viewport()});if(!same(value)||!data||document.hidden)return;
      // Use the backend's inward-rounded rectangle for exact crop/display correspondence.
      rect=data.rect;placement=capturePlacement(data.rect,host);
      phase='ready';previewOpen=false;
      if(placement.kind==='image')sizeObserver.observe(placement.element);
      apply(data);
      if(same(value)&&!document.hidden)void progress('NC_REGION_SUBMIT');
    }catch(error){if(same(value)){beginSelection();state={kind:'error',message:(error as Error).message||msg('截图未能读取，请重新框选。'),retryable:false};paint();}}
    finally{if(same(value)){host.style.removeProperty('visibility');paint();}}
  }
  const point=(event:PointerEvent)=>({x:Math.max(0,Math.min(innerWidth,event.clientX)),y:Math.max(0,Math.min(innerHeight,event.clientY))});
  mask.addEventListener('pointerdown',event=>{
    if(!event.isTrusted||event.button!==0||!event.isPrimary||phase!=='selecting')return;
    event.preventDefault();drag={...point(event),pointerId:event.pointerId};rect=undefined;state=undefined;mask.setPointerCapture(event.pointerId);paint();
  });
  mask.addEventListener('pointermove',event=>{
    if(!event.isTrusted||!drag||event.pointerId!==drag.pointerId)return;
    // A secondary button pressed during pointer capture is a pointermove, not a
    // new pointerdown; the primary preventDefault may suppress its mousedown.
    if(cancelsRegionDrag(event,enabled&&phase==='selecting')){mousedown(event);return;}
    event.preventDefault();rect=selection(drag,point(event));
    Object.assign(outline.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});outline.hidden=false;
  });
  mask.addEventListener('pointerup',event=>{
    if(!event.isTrusted||event.button!==0||!drag||event.pointerId!==drag.pointerId)return;event.preventDefault();const selected=selection(drag,point(event));drag=undefined;
    try{mask.releasePointerCapture(event.pointerId);}catch{}
    if(selected.width<8||selected.height<8){rect=undefined;state={kind:'error',message:msg('选区过小，请重新框选。'),retryable:false};paint();return;}
    void capture(selected);
  });
  mask.addEventListener('pointercancel',()=>{drag=undefined;rect=undefined;paint();});
  function keydown(event:KeyboardEvent){
    handleRegionKey(event,()=>stop(true,true));
  }
  function suppressNextContextMenu(){
    cancelMenuCleanup?.();
    const cleanup=()=>{document.removeEventListener('contextmenu',suppress,true);clearTimeout(deadline);if(cancelMenuCleanup===cleanup)cancelMenuCleanup=undefined;};
    const suppress=(event:MouseEvent)=>{if(!event.isTrusted)return;event.preventDefault();event.stopPropagation();cleanup();};
    const deadline=setTimeout(cleanup,1500);cancelMenuCleanup=cleanup;
    document.addEventListener('contextmenu',suppress,true);
  }
  function mousedown(event:MouseEvent){
    if(!cancelsRegionDrag(event,enabled&&phase==='selecting'))return;
    event.preventDefault();event.stopPropagation();stop(true,true);suppressNextContextMenu();
  }
  function contextmenu(event:MouseEvent){
    if(!event.isTrusted||!enabled||!['selecting','capturing'].includes(phase))return;
    event.preventDefault();event.stopPropagation();stop(true,true);
  }
  function moved(event:Event){
    if(event.composedPath().includes(host))return;
    if(phase==='capturing'){invalidateCapture();return;}
    if(visualViewport&&(visualViewport.scale!==1||visualViewport.offsetLeft!==0||visualViewport.offsetTop!==0)){markChanged();return;}
    if(placement?.kind!=='image'){markChanged();return;}
    schedulePlacement();
  }
  function schedulePlacement(){
    if(!enabled||document.hidden||!placement||invalidPlacement||raf)return;
    raf=requestAnimationFrame(()=>{raf=0;paint();});
  }
  const sizeObserver=new ResizeObserver(schedulePlacement);
  const observer=new MutationObserver(records=>{
    if(!records.some(record=>record.target!==host&&!host.contains(record.target)))return;
    if(phase==='capturing'){invalidateCapture();return;}
    if(placement?.kind!=='image'){markChanged();return;}
    // Ancestor classes, counters and ads are not evidence that the selected
    // pixels changed. Recheck only this image, once per frame, including reflow.
    schedulePlacement();
  });
  function checkNavigation(){
    if(location.href===initialUrl)return;
    stop(false,false);initialUrl=location.href;navigationId=crypto.randomUUID();dismissedUrl='';
  }
  function visibility(){
    if(document.hidden){if(phase==='capturing')invalidateCapture();pause();display.paint(undefined);display.paintLoading(undefined);previewImage.removeAttribute('src');return;}
    checkNavigation();if(!enabled)return;paint();
    // Rehydrate the selected job before opening its result port after an MV3 restart.
    if(submitted||submitIntent)schedule();
    else if(resultKey&&display.key!==resultKey&&!loadError)void loadResult(resultKey);
  }
  function start(){
    if(enabled)stop(false,false);
    cancelMenuCleanup?.();
    initialUrl=location.href;enabled=true;dismissedUrl='';document.documentElement.append(host);
    document.addEventListener('keydown',keydown,true);document.addEventListener('mousedown',mousedown,true);document.addEventListener('contextmenu',contextmenu,true);document.addEventListener('scroll',moved,{passive:true,capture:true});document.addEventListener('load',moved,true);window.addEventListener('resize',moved);
    visualViewport?.addEventListener('resize',moved);visualViewport?.addEventListener('scroll',moved);
    document.addEventListener('visibilitychange',visibility);window.addEventListener('online',visibility);window.addEventListener('offline',visibility);
    window.addEventListener('popstate',checkNavigation);window.addEventListener('hashchange',checkNavigation);window.addEventListener('pagehide',pagehide);
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    navigationTimer=setInterval(checkNavigation,250);beginSelection();
  }
  function pagehide(){stop(false,false);}
  function stop(dismiss:boolean,notify:boolean){
    if(!enabled)return;
    if(notify)void send('NC_REGION_CLOSE').catch(()=>{});
    if(dismiss)dismissedUrl=location.href;
    enabled=false;generation++;activity++;running=undefined;clearTimeout(timer);clearInterval(navigationTimer);cancelAnimationFrame(raf);raf=0;
    observer.disconnect();cancelMenuCleanup?.();clearResources();host.remove();rect=undefined;placement=undefined;selectionId=undefined;drag=undefined;
    document.removeEventListener('keydown',keydown,true);document.removeEventListener('mousedown',mousedown,true);document.removeEventListener('contextmenu',contextmenu,true);document.removeEventListener('scroll',moved,true);document.removeEventListener('load',moved,true);window.removeEventListener('resize',moved);
    visualViewport?.removeEventListener('resize',moved);visualViewport?.removeEventListener('scroll',moved);
    document.removeEventListener('visibilitychange',visibility);window.removeEventListener('online',visibility);window.removeEventListener('offline',visibility);
    window.removeEventListener('popstate',checkNavigation);window.removeEventListener('hashchange',checkNavigation);window.removeEventListener('pagehide',pagehide);
  }
  subscribeLocale(()=>{if(enabled)paint();});
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id)return;
    checkNavigation();
    if(message?.type==='NC_REGION_IDENTITY'){respond(identity());return;}
    if(message?.type==='NC_REGION_START'){start();respond({ok:true});return;}
    if(message?.type==='NC_REGION_STOP'){stop(false,false);respond({ok:true});return;}
    if(message?.type==='NC_REGION_CONFIG_CHANGED'&&enabled){beginSelection();state={kind:'error',message:msg('翻译设置已变化，请重新框选。'),retryable:false};paint();respond({ok:true});}
  });
}
