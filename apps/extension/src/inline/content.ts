import {msg,subscribeLocale} from '../i18n/runtime';
import {readingImages,type InlineResponse,type InlineResult} from './protocol';
import {comicImageRect,MAX_COMIC_IMAGES} from '../sources/comic-images';
import {ImageDisplay} from './display';
import {safeImageUrl} from '../sources/adapters';
import {languageLabel,modeLabels} from '../types';
import {sourceImage} from '../sources/image-fetch';
import {imageDataUrl} from './bytes';
import {translationNotice} from '../translation/notice';

interface Candidate {id:string;image:HTMLImageElement;url:string;rect:DOMRect;display:ImageDisplay;state?:InlineResult['state'];}
export function installInline(){
  const navigationId=crypto.randomUUID();let initialUrl=location.href;
  let automatic=false,dismissedUrl='';
  let translatedView:Pick<InlineResponse,'mode'|'language'>|undefined;
  let enabled=false,paused=false,original=false,running=false,watching=false,generation=0,sequence=0,scope='',signature='',retryId:string|undefined;
  let prefetchAt=0,burstAt=0,scheduledAt=0,policyRevision='',failures=0,leaseTimer:ReturnType<typeof setInterval>|undefined;
  let candidates:Candidate[]=[],windowImages:Candidate[]=[],timer:ReturnType<typeof setTimeout>|undefined,scanTimer:ReturnType<typeof setTimeout>|undefined,raf=0;
  const tracked=new Map<HTMLImageElement,Candidate>();
  const host=document.createElement('div');
  host.style.cssText='all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important';
  const shadow=host.attachShadow({mode:'closed'});
  const style=document.createElement('style');style.textContent=`
    :host{font:13px/1.5 system-ui,sans-serif;color:#23344d;color-scheme:light}
    *{box-sizing:border-box}button{font:inherit;border:0;border-radius:6px;background:#edf3fb;color:#23344d;padding:5px 9px;cursor:pointer;pointer-events:auto}button:hover{background:#dce9fa}button:focus-visible{outline:2px solid #fb7299}
    .bar{position:fixed;bottom:16px;right:16px;max-width:calc(100vw - 32px);display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 10px;border:1px solid #dce3ed;border-radius:12px;background:#fffffff5;box-shadow:0 3px 16px #22334425;pointer-events:auto}
    .label{max-width:260px;margin-right:3px}.status{position:fixed;max-width:260px;padding:5px 9px;border-radius:8px;background:#fffffff2;box-shadow:0 2px 10px #22334420;pointer-events:none;overflow:hidden;text-overflow:ellipsis}.status[data-kind=error]{color:#a33147}.status[data-kind=upgrade]{color:#8d4d00}
    .status button{background:transparent;padding:0;color:inherit;text-align:left}`;
  shadow.append(style);
  const bar=document.createElement('div');bar.className='bar';bar.setAttribute('role','region');bar.setAttribute('aria-label',msg("NodeLane Comics 网页翻译"));
  const label=document.createElement('span');label.className='label';bar.append(label);
  const button=(text:string,action:()=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=action;bar.append(b);return b;};
  const send=(type:string,extra:Record<string,unknown>={})=>chrome.runtime.sendMessage({type,navigationId,generation,...extra});
  const invalidate=()=>{generation++;void send('NC_INLINE_INVALIDATE').catch(()=>{});};
  const pause=button(msg("暂停"),()=>{paused=!paused;pause.textContent=paused?msg("继续"):msg("暂停");invalidate();if(!paused)schedule();paint();});
  const originals=button(msg("恢复原图"),()=>{original=!original;originals.textContent=original?msg("显示译图"):msg("恢复原图");invalidate();if(original)for(const item of tracked.values())item.display.restore();schedule();paint();});
  const settingsButton=button(msg("设置"),()=>{void send('NC_INLINE_OPEN',{view:'settings'});});
  const closeButton=button(msg("关闭"),()=>{dismissedUrl=location.href;stop();});
  subscribeLocale(()=>{settingsButton.textContent=msg('设置');closeButton.textContent=msg('关闭');pause.textContent=paused?msg('继续'):msg('暂停');originals.textContent=original?msg('显示译图'):msg('恢复原图');bar.setAttribute('aria-label',msg('NodeLane Comics 网页翻译'));if(translatedView)label.textContent=msg('漫译 · {0} · {1}',{'0':modeLabels[translatedView.mode],'1':languageLabel(translatedView.language)});scan();});
  shadow.append(bar);
  const badges=document.createElement('div');shadow.append(badges);
  function paint(){
    badges.replaceChildren();if(!enabled||paused||original)return;
    for(const item of windowImages){
      const rect=item.image.getBoundingClientRect(),state=item.state;
      if(!state||rect.bottom<=0||rect.top>=innerHeight||rect.right<=0||rect.left>=innerWidth)continue;
      const badge=document.createElement('div');badge.className='status';badge.dataset.kind=state.kind;
      badge.style.cssText=`top:${Math.max(4,rect.top+8)}px;left:${Math.max(4,Math.min(innerWidth-270,rect.left+8))}px;max-width:${Math.min(260,rect.width-16)}px`;
      const actionable=state.kind==='login'||state.kind==='upgrade'||state.kind==='error'&&state.retryable!==false;
      const notice=translationNotice(state);badge.title=notice.detail;
      if(actionable){const b=document.createElement('button');b.type='button';b.textContent=notice.label;b.onclick=()=>{if(state.kind==='login'||state.kind==='upgrade'){void send('NC_INLINE_OPEN',{view:'account'});return;}retryId=item.id;invalidate();item.state={kind:'translating',message:msg("重试中…")};schedule(0);paint();};badge.append(b);}else badge.textContent=notice.message;
      badges.append(badge);
    }
  }
  function source(image:HTMLImageElement){
    const url=image.currentSrc||image.src;
    if(url.startsWith('blob:')&&new URL(url).origin===location.origin||/^data:image\/(?:png|jpeg|webp|gif|avif);/i.test(url))return url;
    return safeImageUrl(url,location.href);
  }
  function scan(){
    scanTimer=undefined;if(!enabled)return;
    if(location.href!==initialUrl){stop();return;}
    const next:Candidate[]=[];
    for(const image of document.images){
      if(next.length>=MAX_COMIC_IMAGES)break;
      const rect=comicImageRect(image);if(!rect)continue;
      const url=source(image);if(!url)continue;
      let item=tracked.get(image);
      if(item&&item.url!==url){item.display.restore();tracked.delete(image);item=undefined;}
      if(!item){item={id:'image-'+(++sequence),image,url,rect,display:new ImageDisplay(image)};tracked.set(image,item);}
      item.rect=rect;next.push(item);
    }
    const present=new Set(next);
    for(const [image,item] of tracked)if(!present.has(item)){item.display.restore();tracked.delete(image);}
    candidates=next;
    windowImages=document.hidden?[]:readingImages(candidates,innerWidth,innerHeight);
    // As in the reader, keep only a small decoded window on long chapters.
    const current=candidates.indexOf(windowImages[0]),retained=new Set(current<0?[]:candidates.slice(Math.max(0,current-1),current+4));
    for(const item of candidates)if(!retained.has(item))item.display.restore();
    const nextSignature=JSON.stringify(windowImages.map(i=>i.id));
    if(signature!==nextSignature){const first=!signature;signature=nextSignature;prefetchAt=performance.now()+150;invalidate();schedule(first?0:80);}
    if(!scope)label.textContent=candidates.length?msg("漫译 · 发现 {0} 张大图", {"0": candidates.length}):msg("漫译 · 未发现漫画大图，滚动页面继续识别");
    paint();
  }
  function queueScan(){if(!scanTimer)scanTimer=setTimeout(scan,20);if(!raf)raf=requestAnimationFrame(()=>{raf=0;paint();});}
  function schedule(delay=0){const now=performance.now();if(!scheduledAt||now>=scheduledAt)burstAt=now;const due=delay===80?Math.min(now+80,burstAt+200):now+delay;clearTimeout(timer);scheduledAt=due;if(enabled&&!paused&&!original&&!document.hidden&&navigator.onLine!==false)timer=setTimeout(()=>{scheduledAt=0;void tick();},Math.max(0,due-now));}
  const payload=(targets:Candidate[])=>({images:targets.map(i=>({id:i.id,url:/^(blob:|data:)/.test(i.url)?'page-image:'+i.id:i.url,width:i.rect.width,height:i.rect.height})),known:Object.fromEntries(targets.map(i=>[i.id,i.display.key??'']))});
  async function apply(data:InlineResponse,targets:Candidate[],stamp:number){
    if(stamp!==generation||!enabled)return;
    if(scope&&scope!==data.scope)for(const item of tracked.values())item.display.restore();scope=data.scope;
    translatedView=data;label.textContent=msg("漫译 · {0} · {1}", {"0": modeLabels[data.mode], "1": languageLabel(data.language)});
    for(const result of data.items){const item=targets.find(t=>t.id===result.id);if(!item||!item.image.isConnected||source(item.image)!==item.url)continue;item.state=result.state;if(!result.resultKey)item.display.restore();if(result.data&&result.resultKey&&!original){try{await item.display.show(result.data,result.resultKey,()=>enabled&&!original&&stamp===generation&&source(item.image)===item.url);}catch(error){item.state={kind:'error',message:(error as Error).message,retryLabel:msg("点击重新加载")};}}}
    if(data.retryAfterMs)schedule(data.retryAfterMs);
    if(data.needsPlan)schedule();
    if(policyRevision&&data.policyRevision&&policyRevision!==data.policyRevision)schedule();policyRevision=data.policyRevision??policyRevision;paint();
  }
  async function watch(){
    if(watching||!enabled||paused||original||document.hidden||!windowImages.length||navigator.onLine===false)return;watching=true;let retry=0;
    try{while(enabled&&!paused&&!original&&!document.hidden&&windowImages.length){const stamp=generation,targets=[...windowImages];try{const value=await send('NC_INLINE_WAIT',payload(targets));if(!value?.ok){retry=value?.retryAfterMs??Math.min(30000,1000*2**failures++);break;}if(value.data)await apply(value.data,targets,stamp);if(value.data?.scope==='logged-out')break;failures=0;}catch{retry=Math.min(30000,1000*2**failures++);break;}}}finally{watching=false;if(retry&&enabled&&!document.hidden)setTimeout(()=>void watch(),retry+Math.random()*100);}
  }
  async function tick(){
    if(running||!enabled||paused||original||document.hidden)return;
    scan();if(!windowImages.length)return;
    const stamp=generation,targets=windowImages.slice(0,performance.now()<prefetchAt?1:3);running=true;
    const retry=retryId;retryId=undefined;
    try{
      const response=await send('NC_INLINE_TICK',{...payload(targets),retryId:retry});
      if(stamp!==generation||!enabled)return;
      if(!response?.ok){schedule(response?.retryAfterMs??Math.min(30000,1000*2**failures++));throw Error(response?.error??msg("翻译服务暂不可用"));}
      const data=response.data as InlineResponse|undefined;if(!data)return;
      await apply(data,targets,stamp);failures=0;
    }catch(error){if(stamp===generation)for(const item of targets)item.state={kind:'error',message:(error as Error).message};}
    finally{running=false;paint();if(stamp!==generation)schedule();else if(targets.length<windowImages.length)schedule(Math.max(0,prefetchAt-performance.now()));void watch();}
  }
  const hasImage=(node:Node)=>node instanceof Element&&(node instanceof HTMLImageElement||node instanceof HTMLSourceElement||!!node.querySelector('img'));
  const observer=new MutationObserver(records=>{if(records.some(r=>r.type==='attributes'?hasImage(r.target):[...r.addedNodes,...r.removedNodes].some(hasImage)))queueScan();});
  function start(){
    if(enabled){paused=false;original=false;pause.textContent=msg("暂停");originals.textContent=msg("恢复原图");schedule();return;}
    initialUrl=location.href;enabled=true;paused=false;original=false;scope='';signature='';pause.textContent=msg("暂停");originals.textContent=msg("恢复原图");
    document.documentElement.append(host);observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','srcset','sizes','style','class','hidden','width','height']});
    document.addEventListener('scroll',queueScan,{passive:true,capture:true});window.addEventListener('resize',queueScan);document.addEventListener('load',queueScan,true);document.addEventListener('visibilitychange',visibility);window.addEventListener('online',visibility);window.addEventListener('pagehide',stop);scan();schedule();
    leaseTimer=setInterval(()=>{if(enabled&&!paused&&!original&&!document.hidden&&windowImages.length){const stamp=generation,targets=[...windowImages];void send('NC_INLINE_LEASE',payload(targets)).then(value=>{if(value?.ok&&value.data)return apply(value.data,targets,stamp);if(value?.retryAfterMs)schedule(value.retryAfterMs);}).catch(()=>{});}},30000);
  }
  function stop(){
    if(!enabled)return;enabled=false;invalidate();clearTimeout(timer);clearTimeout(scanTimer);clearInterval(leaseTimer);scanTimer=undefined;cancelAnimationFrame(raf);raf=0;observer.disconnect();
    document.removeEventListener('scroll',queueScan,true);window.removeEventListener('resize',queueScan);document.removeEventListener('load',queueScan,true);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('online',visibility);window.removeEventListener('pagehide',stop);
    for(const item of tracked.values())item.display.restore();tracked.clear();candidates=[];windowImages=[];host.remove();
  }
  function visibility(){invalidate();scan();schedule();}
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id)return;
    if(message?.type==='NC_INLINE_IDENTITY'){respond({url:location.href,navigationId,enabled,activeUrl:initialUrl,dismissedUrl});return;}
    if(message?.type==='NC_INLINE_START'){
      if(enabled&&initialUrl!==location.href)stop();
      automatic=message.automatic===true;dismissedUrl='';start();respond({ok:true});return;
    }
    if(message?.type==='NC_INLINE_STOP_AUTO'){if(automatic){stop();automatic=false;}respond({ok:true});return;}
    if(message?.type==='NC_INLINE_CONFIG_CHANGED'&&enabled){scope='';invalidate();for(const item of tracked.values()){item.display.restore();item.state=undefined;}schedule();}
    if(message?.type==='NC_INLINE_SOURCE'&&message.navigationId===navigationId&&enabled){
      const item=windowImages.find(i=>i.id===message.id);
      if(!item||source(item.image)!==item.url||!/^(blob:|data:)/.test(item.url)){respond({error:msg("图片已离开当前阅读范围。")});return;}
      void sourceImage(item.url).then(imageDataUrl).then(data=>respond({data})).catch(error=>respond({error:error.message}));return true;
    }
  });
}
