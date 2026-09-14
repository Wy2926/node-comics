// Manual browser acceptance harness. Only run on the dedicated local test origin.
import {defaults,type Job,type Page} from '../src/types';
import {readChapters,saveChapter,putBlob,saveSettings,saveSession} from '../src/reader/store';
import {emptyPage,makeChapter} from '../src/reader/model';

if(location.hostname!=='127.0.0.1'||location.port!=='5174')throw Error('Use the isolated 127.0.0.1:5174 origin.');
const existing=await readChapters();
if(existing.some(c=>!c.id.startsWith('reader-fixture-')))throw Error('This origin contains non-fixture data. Use another browser profile.');
const origin=location.origin;
const originalFetch=window.fetch.bind(window);
const blob=await (await originalFetch('/samples/starlight-bookshop.png')).blob();
const bitmap=await createImageBitmap(blob);const width=bitmap.width,height=bitmap.height;bitmap.close();
const job=(index:number,status:Job['status']):Job=>({id:`fixture-job-${index}`,input_asset_id:`asset-${index}`,mode:'classic',target_language:'zh-Hans',status,phase:status==='running'?'translating_text':'queued',output_asset_id:status==='succeeded'?`output-${index}`:null,cost:1,version:1,cache_hit:false,created_at:'2026-09-14T00:00:00Z',...(status==='failed'?{error:{code:'FIXTURE_FAILURE',message:'模拟文字识别失败，可手动重试。'}}:{})});
if(!existing.length){
  saveSettings({...defaults,apiBase:origin});saveSession({token:'isolated-fixture-token',user:{id:'fixture-reader',name:'验收账户',role:'reader'},apiOrigin:origin});
  await putBlob('reader-fixture-original',blob);await putBlob('reader-fixture-output',blob);
  const states:Job['status'][]=['queued','running','failed','succeeded','no_text','outcome_unknown'];
  const pages:Page[]=Array.from({length:120},(_,i):Page=>({...emptyPage(`第 ${i+1} 页`,width,height),id:`fixture-page-${i}`,fileHash:'a'.repeat(64),pageIndex:i,blobKey:i===6?undefined:'reader-fixture-original',ownerId:'fixture-reader',apiOrigin:origin,jobs:i<states.length?[job(i,states[i])]:[],outputBlobs:i===3?{'fixture-job-3':'reader-fixture-output'}:{}}));
  for(const [i,title] of ['星光书店','星光书店与长长的夏日来信：一段会跨越两行标题的故事','星光书店 · 第三卷'].entries())await saveChapter({...makeChapter(title,i===0?pages:pages.slice(0,9),i===1?'原创漫画 · 很长的来源说明应保持在同一行并显示省略号':'原创验收样本'),id:`reader-fixture-${i}`});
}
const stored=await readChapters();
const jobs=new Map(stored.flatMap(c=>c.pages.flatMap(p=>p.jobs.map(j=>[j.id,j] as const))));
const quotes=new Map<string,{asset_ids:string[];mode:Job['mode'];target_language:string}>();
const batches=new Map<string,unknown>();
const state={submitted:[] as number[],requests:[] as string[],delay:0,unknown:false,price:1,failNext:false};
Object.assign(window,{readerFixture:state});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(input,init={})=>{
  const url=new URL(String(input),origin);if(url.origin!==origin)throw Error('External requests disabled in this fixture.');
  if(!url.pathname.startsWith('/v1/'))return originalFetch(input,init);
  state.requests.push(url.pathname);
  if(state.delay)await new Promise(r=>setTimeout(r,state.delay));
  if(state.failNext){state.failNext=false;throw Error('Fixture offline');}
  const body=typeof init.body==='string'?JSON.parse(init.body):{};
  const asset=(i:number)=>({id:`asset-${i}`,width,height,expires_at:'2099-01-01T00:00:00Z'});
  if(url.pathname==='/v1/capabilities')return json({modes:[{id:'classic',enabled:true,unit_cost:state.price},{id:'redraw',enabled:true,unit_cost:3}],languages:[{id:'zh-Hans',label:'简体中文'},{id:'en',label:'English'},{id:'ja',label:'日本語'}],limits:{max_batch:4},quota:{balance:10000,available:10000,reserved:0},retention_days:7});
  if(url.pathname==='/v1/auth/config')return json({mode:'dev',dev_auth:true});
  if(url.pathname==='/v1/me/usage')return json({balance:10000,available:10000-state.submitted.length,reserved:state.submitted.length,items:[],total:0});
  if(url.pathname==='/v1/file-pages/match')return json({items:body.pages.map((p:{file_hash:string;page_index:number})=>({...p,asset:p.page_index===6?null:asset(p.page_index),jobs:[...jobs.values()].filter(j=>j.input_asset_id===`asset-${p.page_index}`&&j.mode===body.mode&&j.target_language===body.target_language),display_jobs:[...jobs.values()].filter(j=>j.input_asset_id===`asset-${p.page_index}`&&j.mode===body.mode&&j.target_language===body.target_language)}))});
  if(url.pathname==='/v1/quotes'){const id=crypto.randomUUID();quotes.set(id,body);return json({id,unit_cost:state.price,total_cost:body.asset_ids.length*state.price,page_count:body.asset_ids.length,expires_at:'2099-01-01T00:00:00Z',config_version:'fixture-v1'});}
  if(url.pathname==='/v1/translation-batches'){
    const key=new Headers(init.headers).get('Idempotency-Key')!;
    if(batches.has(key))return json(batches.get(key));
    const quote=quotes.get(body.quote_id)!;
    const result=quote.asset_ids.map(a=>{const i=Number(a.replace('asset-',''));const j={...job(i,'queued'),id:`submitted-${crypto.randomUUID()}`,mode:quote.mode,target_language:quote.target_language};jobs.set(j.id,j);state.submitted.push(i);return j;});
    const response={id:key,status:'queued',jobs:result,total_cost:result.length};batches.set(key,response);
    if(state.unknown){state.unknown=false;throw Error('Fixture response lost after acceptance');}return json(response);
  }
  if(url.pathname==='/v1/jobs/status')return json({items:body.ids.map((id:string)=>jobs.get(id)).filter(Boolean)});
  if(url.pathname.endsWith('/access'))return json({url:`${origin}/v1/fixture-output`,expires_at:'2099-01-01T00:00:00Z'});
  if(url.pathname==='/v1/fixture-output')return new Response(blob);
  if(url.pathname.endsWith('/cancel')){const id=url.pathname.split('/')[3];const j=jobs.get(id)!;j.status='cancelled';return json(j);}
  if(url.pathname==='/v1/me/queue')return json({concurrency:2,effective_concurrency:2,default_concurrency:2,max_concurrency:10,queued:0,dispatched:0,running:0});
  if(url.pathname==='/v1/me/feedback')return json({items:[],total:0});
  return json({error:{code:'FIXTURE_ROUTE_MISSING',message:`Unimplemented fixture route: ${url.pathname}`}},404);
};
await import('../src/main');
