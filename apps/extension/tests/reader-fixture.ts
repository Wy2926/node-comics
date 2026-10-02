import {browserOverlay} from './overlay-fixture';
import {billingOffer} from './billing-fixture-data';
import {saveSession} from '../src/auth/storage';
import {API_ORIGIN} from '../src/service';
import {defaults,type Job,type Entitlements,type TranslationInput,type TranslationSnapshot} from '../src/types';
import {saveSettings} from '../src/comics/application/preferences';
import {seedReaderFixture} from './reader-fixture-data';

if(location.origin!=='http://127.0.0.1:5176')throw Error('Use a new profile on the isolated http://127.0.0.1:5176 origin.');
const origin=API_ORIGIN,parameters=new URLSearchParams(location.search),autoScenario=parameters.get('auto');
await saveSettings({...defaults,uiLanguage:'zh-CN',appearance:parameters.get('theme')==='dark'?'dark':'light'});
await saveSession({id:crypto.randomUUID(),expiresAt:Date.now()+3600000,refreshAt:Date.now()+3540000,credential:{kind:'development'},token:'isolated-fixture-token',user:{id:autoScenario?'fixture-'+autoScenario:'fixture-reader',name:'隔离阅读验收',role:'reader'},apiOrigin:origin});
const originalFetch=window.fetch.bind(window);
const overlay=await browserOverlay(),blob=overlay.blob;
const job=(index:number,status:Job['status']):Job=>({id:`fixture-job-${index}`,mode:'classic',target_language:'zh-Hans',status,phase:status==='running'?'translating_text':'queued',quota_pages:1,version:1,cache_hit:false,created_at:'2026-09-14T00:00:00Z',...(status==='failed'?{error:{code:'FIXTURE_FAILURE',message:'模拟文字识别失败，可手动重试。'}}:{})});
const {copies:stored,ordinals,imageOrdinals}=await seedReaderFixture(origin,autoScenario,job,overlay.result);
const jobs=new Map(stored.flatMap(c=>c.pages.flatMap(p=>p.jobs.map(j=>[j.id,j] as const))));
const operations=new Map<string,string>();
const paid=parameters.get('billing')==='paid'||parameters.has('lite')||autoScenario==='lite';
const rights:Entitlements={plan:paid?'lite':'free',plus_started_at:null,plus_expires_at:null,timezone:'Asia/Shanghai',image_rate_limit:{window_seconds:60,limit:paid?100:10},pending_previous_period_pages:0,generated_at:new Date().toISOString(),modes:{classic:{allowed:true,unlimited:false,quota_kind:'classic_daily',consent_version:'fixture-v3',quota:{id:'daily',kind:'classic_daily',granted:1000,used:0,reserved:0,available:1000,starts_at:'2026-09-15',resets_at:null,next_expiry_at:'2099-01-01',buckets:[]}}}};
if(new URLSearchParams(location.search).has('billing')){
 rights.plus_expires_at=paid?'2026-10-20T00:00:00Z':null;
 rights.modes.classic.unlimited=paid;
}
if(paid)rights.hourly_image_rate_limit={window_seconds:3600,limit:1200};
if(autoScenario==='quota')rights.modes.classic.quota!.available=0;
if(autoScenario==='lite')rights.modes.classic={...rights.modes.classic,unlimited:true,quota_kind:'classic_unlimited'};
const activeCount=()=>[...jobs.values()].filter(j=>['awaiting_upload','validating_upload','queued','running','outcome_unknown'].includes(j.status)).length;
for(const copy of stored)for(const page of copy.pages)for(const job of page.jobs)Object.assign(job,{image_sha256:page.imageSha256});

const state={ordinals,imageOrdinals,get jobs(){return [...jobs.values()];},rateBlockedUntil:0,translationRequests:[] as {id:string;body:TranslationInput}[],completedAt:0,downloadedAt:0,finishNext(){const next=[...jobs.values()].find(j=>['running','queued'].includes(j.status));if(next){next.status='succeeded';state.completedAt=performance.now();}return next?.id;},submitted:[] as number[],requests:[] as string[],delay:0,unknown:false,price:1,failNext:false,offline:new URLSearchParams(location.search).has('offline'),failDownloads:false};
Object.assign(window,{readerFixture:state});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(input,init={})=>{
  const url=new URL(String(input),origin);if(url.origin!==origin&&url.origin!==location.origin)throw Error('External requests disabled in this fixture.');
  if(!url.pathname.startsWith('/v1/'))return originalFetch(input,init);
  state.requests.push(url.pathname);
  if(state.delay)await new Promise(r=>setTimeout(r,state.delay));
  if(state.offline||state.failDownloads&&url.pathname.endsWith('/result'))throw Error('网络连接失败（隔离验收）');
  if(state.failNext){state.failNext=false;throw Error('网络连接失败（隔离验收）');}
  const body=typeof init.body==='string'?JSON.parse(init.body):{};
  if(url.pathname==='/v1/capabilities')return json({result_protocol:'overlay-v1',modes:[{id:'classic',enabled:true,unit_cost:state.price}],languages:[{id:'zh-Hans',label:'简体中文'},{id:'en',label:'English'},{id:'ja',label:'日本語'}],limits:{max_translation_ids:32,max_bytes:20971520,max_pixels:40000000,max_dimension:12000},entitlements:rights});
  if(url.pathname==='/v1/auth/config')return json({mode:'dev',dev_auth:true});
  const billingScenario=new URLSearchParams(location.search).get('billing');
  const billing={offers:[billingOffer],checkout_price:null,enabled:!!billingScenario&&billingScenario!=='disabled',providers:[{id:'stripe',label:'Stripe',environment:'test'},{id:'creem',label:'Creem',environment:'test'}],provider:'stripe',environment:'test',checkout_provider:null,trial_eligible:billingScenario!=='paid',gift:null,entitlement_expires_at:null,checkout_pending:false,subscription:billingScenario==='paid'?{provider:'stripe',price:billingOffer,status:'active',next_billed_at:'2026-10-20T00:00:00Z',cancel_at:null,trial_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null,paid_ends_at:'2026-10-20T00:00:00Z'}:null};
  if(url.pathname==='/v1/billing/status')return billingScenario==='error'?json({error:{message:'Isolated billing failure'}},503):json(billing);
  if(url.pathname==='/v1/billing/sync')return json({billing,entitlements:rights});
  if(url.pathname==='/v1/billing/checkouts')return billingScenario==='checkout-error'?json({error:{message:'Isolated checkout failure'}},503):json({checkout_url:'https://checkout.stripe.com/c/pay/cs_test_fixture',trial:true,environment:'test',provider:'stripe'});
  if(url.pathname==='/v1/billing/portal')return json({url:'https://billing.stripe.com/p/session/fixture',provider:'stripe'});
  if(url.pathname==='/v1/me/entitlements')return json(rights);
  if(url.pathname==='/v1/me/usage/summary')return json({entitlements:rights,timezone:'Asia/Shanghai',start_date:'2026-09-14',end_date:'2026-09-20',generated_at:new Date().toISOString(),delivered:0,free_delivered:0,included_delivered:0,by_mode:{},quota_used:{},days:[]});
  if(url.pathname==='/v1/me/usage')return json({entitlements:rights,items:[],total:0});
  const snapshot=(id:string):TranslationSnapshot|undefined=>{
    const j=jobs.get(operations.get(id)??id);if(!j)return;
    return {id,mode:j.mode,target_language:j.target_language,image_sha256:j.image_sha256,created_at:j.created_at,updated_at:j.updated_at,state:j.status==='awaiting_upload'?'needs_input':j.status==='validating_upload'?'queued':j.status==='outcome_unknown'||j.status==='unknown_released'?'needs_attention':j.status==='cancelled'?'failed':j.status==='no_text'?'succeeded':j.status,error:j.error,result:j.status==='no_text'?{kind:'no_text',representation:'original',normalization_version:1,input_sha256:j.image_sha256!,width:640,height:900}:j.status==='succeeded'?overlay.result(id,j.image_sha256!):null};
  };
  if(url.pathname==='/v1/translations/events'){
    const ids=(url.searchParams.get('ids')??'').split(',');let timer:ReturnType<typeof setInterval>|undefined,close=()=>{};
    const stream=new ReadableStream<Uint8Array>({start(controller){
      let old='',closed=false;const encoder=new TextEncoder();
      close=()=>{if(closed)return;closed=true;clearInterval(timer);init.signal?.removeEventListener('abort',close);controller.close();};
      const update=()=>{
        const items=ids.map(snapshot).filter((item):item is TranslationSnapshot=>!!item),data=JSON.stringify({items,missing_ids:ids.filter(id=>!snapshot(id))});
        if(data!==old){old=data;controller.enqueue(encoder.encode('event: snapshot\ndata: '+data+'\n\n'));}
        if(items.every(item=>['succeeded','failed'].includes(item.state))){controller.enqueue(encoder.encode('event: end\ndata: {"reason":"complete"}\n\n'));close();}
      };
      timer=setInterval(update,25);init.signal?.addEventListener('abort',close,{once:true});update();
    },cancel(){close();}});
    return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
  }
  const translationPath=url.pathname.match(/^\/v1\/translations\/([^/]+)(?:\/(input))?$/);
  if(translationPath){
    const [,id,action]=translationPath;
    if(action==='input'){const j=jobs.get(operations.get(id)??id)!;j.status=autoScenario?'running':'queued';return json(snapshot(id));}
    if(init.method!=='PUT')return snapshot(id)?json(snapshot(id)):json({error:{code:'NOT_FOUND',message:'Not found'}},404);
    const value=body as TranslationInput;state.translationRequests.push({id,body:value});
    if(operations.has(id))return json(snapshot(id));
    const prior='retry_of' in value?snapshot(value.retry_of):'regenerate_of' in value?snapshot(value.regenerate_of):undefined;
    const sha='image' in value?value.image.sha256:prior?.image_sha256,mode='image' in value?value.mode:prior!.mode,language='image' in value?value.target_language:prior!.target_language;
    const index=sha?imageOrdinals[sha]:undefined;if(index===undefined)throw Error('Unknown fixture image identity.');
    const matching='image' in value?[...jobs.values()].filter(j=>j.image_sha256===sha&&j.mode===mode&&j.target_language===language).at(-1):undefined;
    if(matching){operations.set(id,matching.id);return json(snapshot(id));}
    if(Date.now()<state.rateBlockedUntil)return new Response(JSON.stringify({error:{code:'IMAGE_RATE_LIMITED',message:'等待翻译'}}),{status:429,headers:{'Content-Type':'application/json','Retry-After':String(Math.ceil((state.rateBlockedUntil-Date.now())/1000))}});
    if(rights.modes[mode].quota?.available===0)return json({error:{code:'DAILY_QUOTA_EXHAUSTED',message:'升级权益，继续翻译'}},403);
    const j:Job={...job(index,'awaiting_upload'),id,mode,target_language:language,image_sha256:sha,created_at:new Date().toISOString()};jobs.set(id,j);operations.set(id,id);state.submitted.push(index);
    if(state.unknown){state.unknown=false;throw Error('Fixture response lost after acceptance');}
    return json(snapshot(id),202);
  }
  if(url.pathname==='/v1/translations'){
    const ids=(url.searchParams.get('ids')??'').split(',').filter(Boolean);
    const values=()=>({items:ids.map(snapshot).filter((x):x is TranslationSnapshot=>!!x),missing_ids:ids.filter(id=>!snapshot(id))});
    const etag=()=>JSON.stringify(JSON.stringify(values())),old=new Headers(init.headers).get('If-None-Match');
    if(old===etag())return new Response(null,{status:304,headers:{ETag:etag()}});
    return new Response(JSON.stringify(ids.length?values():{items:[...operations.keys()].map(snapshot),total:operations.size,next_offset:null}),{headers:{'Content-Type':'application/json',ETag:etag()}});
  }
  if(url.pathname.endsWith('/result')){state.downloadedAt=performance.now();return new Response(blob);}
  if(url.pathname.endsWith('/cancel')){const id=url.pathname.split('/')[3];const j=jobs.get(id)!;j.status='cancelled';return json(j);}
  if(url.pathname==='/v1/me/feedback')return json({items:[],total:0});
  return json({error:{code:'FIXTURE_ROUTE_MISSING',message:`Unimplemented fixture route: ${url.pathname}`}},404);
};
await import('../src/main');
if(new URLSearchParams(location.search).has('directory')){const output=document.createElement('output');output.id='fixture-requests';output.style.cssText='position:fixed;bottom:0;right:0;z-index:100;font-size:10px;background:#fff;color:#555;padding:2px 6px';document.body.append(output);setInterval(()=>{output.textContent=`隔离验收 · 新翻译 ${state.submitted.length} 页 · 翻译请求 ${state.translationRequests.length} 次`;},500);}

if(autoScenario||new URLSearchParams(location.search).has('controls')){
 const panel=document.createElement('div');panel.style.cssText='position:fixed;bottom:0;right:0;z-index:100;background:#fff;color:#555;padding:4px;font-size:11px';
 const output=document.createElement('output');panel.append(output);
 for(const [label,status] of [['模拟完成','succeeded'],['模拟失败','failed']] as const){const button=document.createElement('button');button.textContent=label;button.onclick=()=>{for(const j of jobs.values())if(['queued','running','validating_upload'].includes(j.status)){j.status=status;j.updated_at=new Date().toISOString();if(status==='failed')j.error={code:'FIXTURE_FAILURE',message:'模拟翻译失败，点击重试'};}};panel.append(button);}
 const upgrade=document.createElement('button');upgrade.textContent='模拟权益恢复';upgrade.onclick=()=>{rights.modes.classic.quota!.available=100;window.dispatchEvent(new Event('focus'));};panel.append(upgrade);
 document.body.append(panel);
 setInterval(()=>{output.textContent=`新提交 ${state.submitted.length} 张 [${state.submitted.map(n=>n+1).join(',')}] · 在途 ${activeCount()} · `;},200);
}

if(autoScenario==='pipeline'){
 const tools=document.createElement('div');tools.style.cssText='position:fixed;bottom:0;right:0;z-index:1000;background:white;color:#222;padding:8px';
 const finish=document.createElement('button');finish.textContent='完成下一页（隔离验收）';finish.onclick=()=>state.finishNext();
 const output=document.createElement('output');output.id='pipeline-metrics';
 tools.append(finish,output);document.body.append(tools);
 setInterval(()=>{output.textContent=` 提交 ${state.submitted.length} 页 · 更新请求 ${state.requests.filter(p=>p==='/v1/translations').length} · 完成到下载 ${state.completedAt&&state.downloadedAt>=state.completedAt?(state.downloadedAt-state.completedAt).toFixed(0)+' ms':'等待'}`;},100);
}
