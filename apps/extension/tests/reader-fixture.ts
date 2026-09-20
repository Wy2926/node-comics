import {saveSession} from '../src/auth/storage';
import {API_ORIGIN} from '../src/service';
// Manual browser acceptance harness. Only run on the dedicated local test origin.
import {defaults,type Job,type Page,type Entitlements,type TranslationPlan,type TranslationOperation} from '../src/types';
import {readCopies,readLibrary,commitCopies,putBlob,saveSettings,editLibrary} from '../src/library/store';
import {emptyPage} from '../src/reader/model';
import {makeCopy} from '../src/library/model';

if(location.hostname!=='127.0.0.1'||!['5174','5176','5179'].includes(location.port))throw Error('Use the isolated 127.0.0.1:5174, :5176 or :5179 origin.');
const existing=await readCopies();
if(existing.some(c=>!c.id.startsWith('reader-fixture-')))throw Error('This origin contains non-fixture data. Use another browser profile.');
const origin=API_ORIGIN;
const originalFetch=window.fetch.bind(window);
const blob=await (await originalFetch('/samples/starlight-bookshop.png')).blob();
const bitmap=await createImageBitmap(blob);const width=bitmap.width,height=bitmap.height;bitmap.close();
const job=(index:number,status:Job['status']):Job=>({id:`fixture-job-${index}`,input_asset_id:`asset-${index}`,mode:'classic',target_language:'zh-Hans',status,phase:status==='running'?'translating_text':'queued',output_asset_id:status==='succeeded'?`output-${index}`:null,quota_pages:1,version:1,cache_hit:false,created_at:'2026-09-14T00:00:00Z',...(status==='failed'?{error:{code:'FIXTURE_FAILURE',message:'模拟文字识别失败，可手动重试。'}}:{})});
if(!existing.length){
  saveSettings(defaults);await saveSession({id:crypto.randomUUID(),expiresAt:Date.now()+3600000,refreshAt:Date.now()+3540000,credential:{kind:'development'},token:'isolated-fixture-token',user:{id:'fixture-reader',name:'验收账户',role:'reader'},apiOrigin:origin});
  await putBlob('reader-fixture-original',blob);await putBlob('reader-fixture-output',blob);
  const states:Job['status'][]=['queued','running','failed','succeeded','no_text','outcome_unknown'];
  const pages:Page[]=Array.from({length:120},(_,i):Page=>({...emptyPage(`第 ${i+1} 页`,width,height),id:`fixture-page-${i}`,fileHash:'a'.repeat(64),pageIndex:i,blobKey:i===6?undefined:'reader-fixture-original',ownerId:'fixture-reader',apiOrigin:origin,jobs:i<states.length?[job(i,states[i])]:[],outputBlobs:i===3?{'fixture-job-3':'reader-fixture-output'}:{}}));
  for(const [i,title] of ['星光书店','星光书店与长长的夏日来信：一段会跨越两行标题的故事','星光书店 · 第三卷'].entries())await commitCopies([{...makeCopy(title,i===0?pages:pages.slice(0,9),i===1?'原创漫画 · 很长的来源说明应保持在同一行并显示省略号':'原创验收样本'),id:`reader-fixture-${i}`}],[{title,kind:'chapter'}]);
}
// Optional directory/edition scenarios, limited to this isolated fixture database.
if(new URLSearchParams(location.search).has('directory')&&!localStorage.getItem('reader-fixture-directory')){
 await editLibrary((library,copies)=>{
  const first=copies.find(c=>c.id==='reader-fixture-0')!;
  const coverage=library.coverage.find(c=>c.copyId===first.id)!;
  const workId=coverage.workId;
  for(const c of library.coverage)c.workId=workId;
  library.chapters.forEach((c,n)=>{c.workId=workId;c.title=['第 1 话 · 雨后的来信','第 2 话 · 夜间营业与一封跨越夏日的长长来信','第 3 话 · 未寄出的明信片'][n];c.order=n;c.number=String(n+1);c.role='main';});
  library.works=library.works.filter(w=>w.id===workId);
  for(let n=3;n<12;n++)library.chapters.push({...library.chapters[0],id:'reader-fixture-chapter-'+n,title:'第 '+(n+1)+' 话 · 旅行的猫',number:String(n+1),order:n,role:n===11?'extra':'main'});
  first.pages[4].jobs.push({...job(4,'succeeded'),id:'fixture-en-4',target_language:'en'});
  first.pages[5].jobs.push({...job(5,'succeeded'),id:'fixture-redraw-5',mode:'redraw',output_asset_id:null,result_expired:true});
  first.pages[6].fetchError='模拟原图缺失，请重新导入。';
  const second=copies.find(c=>c.id==='reader-fixture-1')!;second.title=library.chapters.find(c=>c.id===library.coverage.find(x=>x.copyId===second.id)!.target.id)!.title;second.source='另一个来源';second.versionId='reader-fixture-version';
  library.versions.push({id:second.versionId,workId,title:'其它扫描版本',evidence:{status:'user',source:'隔离验收'}});
  const third=copies.find(c=>c.id==='reader-fixture-2')!;third.pages=third.pages.map(p=>({...p,blobKey:undefined}));
  library.tasks.push({id:'reader-fixture-failed',copyId:third.id,status:'failed',phase:'images',completed:0,total:9,error:'模拟来源暂不可用，已保留进度。',updatedAt:Date.now()});
 });
 localStorage.setItem('reader-fixture-directory','v1');
}
if(new URLSearchParams(location.search).has('empty')&&!localStorage.getItem('reader-fixture-empty')){
 await editLibrary((library,copies)=>{const chapter=library.chapters.find(c=>c.id==='reader-fixture-chapter-3');if(!chapter)return;const copy={...makeCopy(chapter.title,[]),id:'reader-fixture-empty'};copies.push(copy);library.coverage.push({id:'reader-fixture-empty-coverage',copyId:copy.id,workId:chapter.workId,target:{kind:'chapter',id:chapter.id},evidence:{status:'user',source:'隔离验收'}});});
 localStorage.setItem('reader-fixture-empty','v1');
}
// Separate small chapters exercise boundaries, including repeated page IDs in different copies.
const flow=new URLSearchParams(location.search).get('flow');
if(flow&&['complete','backward','incomplete','missing','empty','gap','snapshot'].includes(flow)&&!(await readCopies()).some(c=>c.id===`reader-fixture-flow-${flow}-0`)){
 const chapters=(flow==='snapshot'?[4]:[2,2,1]).map((count,n)=>({...makeCopy(`连读 ${flow} · 第 ${n+1} 话`,Array.from({length:count},(_,i)=>({...emptyPage(`第 ${i+1} 页`,width,height),id:`flow-page-${i}`,blobKey:flow==='missing'&&n===0&&i===0?undefined:'reader-fixture-original'})),'连读验收'),id:`reader-fixture-flow-${flow}-${n}`}));
 if(flow==='incomplete'){chapters[0].discoveryComplete=false;Object.assign(chapters[0],{knownTotal:4,sourceEntryId:'fixture-incomplete-source'});}
 if(flow==='snapshot')Object.assign(chapters[0],{discoveryComplete:false,knownTotal:undefined,source:'网页图片',sourceKey:'web:fixture-snapshot'});
 if(flow==='empty')chapters[1].pages=[];
 if(flow==='gap')chapters[1].source='其它版本';
 await commitCopies(chapters,chapters.map((c,n)=>({title:c.title,kind:'chapter',number:String(n+1)})));
 if(flow==='empty')await editLibrary(s=>{s.tasks.push({id:'reader-fixture-flow-empty-task',copyId:chapters[1].id,status:'failed',phase:'images',completed:0,error:'模拟下一话采集失败，请重试。',updatedAt:Date.now()});});
}
const autoScenario=new URLSearchParams(location.search).get('auto');
if(autoScenario){
 saveSettings(defaults);
 await saveSession({id:crypto.randomUUID(),expiresAt:Date.now()+3600000,refreshAt:Date.now()+3540000,credential:{kind:'development'},token:'isolated-fixture-token',user:{id:'fixture-'+autoScenario,name:'自动翻译验收',role:'reader'},apiOrigin:origin});
 const copyId='reader-fixture-auto-'+autoScenario;
 if(!(await readCopies()).some(c=>c.id===copyId)){
  const pages=Array.from({length:['retry','connection'].includes(autoScenario)?1:30},(_,n)=>({...emptyPage(`自动第 ${n+1} 页`,width,height),id:copyId+'-'+n,fileHash:autoScenario==='plus'?'b'.repeat(64):autoScenario==='quota'?'c'.repeat(64):'d'.repeat(64),pageIndex:n,imageSha256:(n+1).toString(16).padStart(64,'0'),imageByteSize:blob.size,imageMime:blob.type,blobKey:'reader-fixture-original',ownerId:'fixture-'+autoScenario,apiOrigin:origin,...(autoScenario==='retry'?{assetId:`asset-${n}`,jobs:[job(n,'failed')]}:{})}));
  await commitCopies([{...makeCopy('自动翻译 · '+autoScenario,pages,'隔离验收'),id:copyId}],[{title:'自动翻译 · '+autoScenario,kind:'work'}]);
 }
}
const stored=(await readCopies()).filter(c=>!autoScenario||c.id==='reader-fixture-auto-'+autoScenario);
const jobs=new Map(stored.flatMap(c=>c.pages.flatMap(p=>p.jobs.map(j=>[j.id,j] as const))));
const operations=new Map<string,TranslationOperation>();
const plus=new URLSearchParams(location.search).has('plus')||autoScenario==='plus';
const rights:Entitlements={plan:plus?'plus':'free',plus_started_at:null,plus_expires_at:null,timezone:'Asia/Shanghai',image_rate_limit:{window_seconds:60,limit:plus?100:30},scheduler_weight:plus?2:1,pending_previous_period_pages:0,generated_at:new Date().toISOString(),modes:{classic:{allowed:true,unlimited:false,quota_kind:'classic_daily',consent_version:'fixture-v3',quota:{id:'daily',kind:'classic_daily',granted:1000,used:0,reserved:0,available:1000,starts_at:'2026-09-15',resets_at:null,next_expiry_at:'2099-01-01',buckets:[]}},redraw:{allowed:true,unlimited:false,quota_kind:'redraw_grant',consent_version:'fixture-v3',quota:{id:'redraw',kind:'redraw_grant',granted:1000,used:0,reserved:0,available:1000,starts_at:'2026-09-15',resets_at:null,next_expiry_at:'2099-01-01',buckets:[]}}}};
if(autoScenario==='quota')rights.modes.classic.quota!.available=0;
if(autoScenario==='plus')rights.modes.classic={...rights.modes.classic,unlimited:true,quota_kind:'classic_unlimited'};
const activeCount=()=>[...jobs.values()].filter(j=>['awaiting_upload','validating_upload','queued','running','outcome_unknown'].includes(j.status)).length;
for(const copy of stored)for(const page of copy.pages){for(const job of page.jobs)Object.assign(job,{file_hash:page.fileHash,page_index:page.pageIndex,image_sha256:page.imageSha256});}

let changeRevision=0, previousJobs='[]',policyRevision=1,previousRights=JSON.stringify(rights);
const state={rateBlockedUntil:0,planBodies:[] as TranslationPlan[],completedAt:0,downloadedAt:0,finishNext(){const next=[...jobs.values()].find(j=>['running','queued'].includes(j.status));if(next){next.status='succeeded';next.output_asset_id='output-'+next.id;state.completedAt=performance.now();}return next?.id;},submitted:[] as number[],requests:[] as string[],delay:0,unknown:false,price:1,failNext:false,offline:new URLSearchParams(location.search).has('offline'),failDownloads:false};
// Optional deterministic redraw lifecycle for manual UI acceptance; no supplier calls.
const redrawOutcome=new URLSearchParams(location.search).get('redrawOutcome');
const redrawEnabled=new URLSearchParams(location.search).get('redrawEnabled')!=='false';
const redrawPolls=new Map<string,number>();
Object.assign(window,{readerFixture:state});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(input,init={})=>{
  const url=new URL(String(input),origin);if(url.origin!==origin&&url.origin!==location.origin)throw Error('External requests disabled in this fixture.');
  if(!url.pathname.startsWith('/v1/'))return originalFetch(input,init);
  state.requests.push(url.pathname);
  if(state.delay)await new Promise(r=>setTimeout(r,state.delay));
  if(state.offline||state.failDownloads&&url.pathname==='/v1/fixture-output')throw Error('网络连接失败（隔离验收）');
  if(state.failNext){state.failNext=false;throw Error('网络连接失败（隔离验收）');}
  const body=typeof init.body==='string'?JSON.parse(init.body):{};
  const asset=(i:number)=>({id:`asset-${i}`,width,height,expires_at:null});
  if(url.pathname==='/v1/capabilities')return json({modes:[{id:'classic',enabled:true,unit_cost:state.price},{id:'redraw',enabled:redrawEnabled,unit_cost:3}],languages:[{id:'zh-Hans',label:'简体中文'},{id:'en',label:'English'},{id:'ja',label:'日本語'}],limits:{max_plan_items:3,max_bytes:20971520,max_pixels:40000000,max_dimension:12000},entitlements:rights,retention_days:0});
  if(url.pathname==='/v1/auth/config')return json({mode:'dev',dev_auth:true});
  if(url.pathname==='/v1/billing/status')return json({enabled:false,environment:'sandbox',trial_eligible:true,checkout_pending:false,subscription:null,entitlement_expires_at:null});
  if(url.pathname==='/v1/me/entitlements')return json(rights);
  if(url.pathname==='/v1/me/usage')return json({entitlements:rights,items:[],total:0});
  if(url.pathname==='/v1/file-pages/match')return json({items:body.pages.map((p:{file_hash:string;page_index:number})=>({...p,asset:p.page_index===6?null:asset(p.page_index),jobs:[...jobs.values()].filter(j=>j.input_asset_id===`asset-${p.page_index}`&&j.mode===body.mode&&j.target_language===body.target_language),display_jobs:[...jobs.values()].filter(j=>j.input_asset_id===`asset-${p.page_index}`&&j.mode===body.mode&&j.target_language===body.target_language)}))});
  const policy=()=>{if(previousRights!==JSON.stringify(rights)){previousRights=JSON.stringify(rights);policyRevision++;}return String(policyRevision);};
  const receipt=(operation:TranslationOperation):TranslationOperation=>{const j=operation.job&&jobs.get(operation.job.id);return j?{...operation,job:j,...(j.error?{message:j.error.message,code:j.error.code}:{}),disposition:j.status==='succeeded'||j.status==='no_text'?'ready':['failed','cancelled','outcome_unknown'].includes(j.status)?'blocked':'pending',upload:j.status==='awaiting_upload'?operation.upload:null}:operation;};
  if(url.pathname==='/v1/translation-plans'&&init.method==='POST'){
    const value=body as TranslationPlan;state.planBodies.push(value);
    const items:TranslationOperation[]=value.items.map(item=>{
      const old=operations.get(item.operation_key);if(old)return {...receipt(old),page_key:item.page_key};
      const image=item.image;
      const matching=[...jobs.values()].filter(j=>j.image_sha256===image.image_sha256&&j.mode===item.mode&&j.target_language===item.target_language).at(-1);
      if(matching&&(!item.action||item.action==='ensure')){const op={page_key:item.page_key,operation_key:item.operation_key,disposition:'pending' as const,job:matching,created_at:matching.created_at};operations.set(item.operation_key,op);return receipt(op);}
      if(Date.now()<state.rateBlockedUntil)return {page_key:item.page_key,operation_key:item.operation_key,disposition:'deferred',code:'IMAGE_RATE_LIMITED',retry_after_seconds:Math.ceil((state.rateBlockedUntil-Date.now())/1000)};
      if(value.allow_new===false)return {page_key:item.page_key,operation_key:item.operation_key,disposition:'deferred',code:'NEW_TRANSLATION_NOT_REQUESTED'};
      if(item.max_quota_pages===0||rights.modes[item.mode].quota?.available===0)return {page_key:item.page_key,operation_key:item.operation_key,disposition:'blocked',code:'DAILY_QUOTA_EXHAUSTED',message:'升级权益，继续翻译'};
      const j:Job={...job(image.page_index??0,image.asset_id?'queued':'awaiting_upload'),id:'submitted-'+crypto.randomUUID(),mode:item.mode,target_language:item.target_language,file_hash:image.file_hash,page_index:image.page_index,image_sha256:image.image_sha256,created_at:new Date().toISOString(),input_asset_id:image.asset_id??null};
      jobs.set(j.id,j);state.submitted.push(image.page_index??0);
      const op:TranslationOperation={page_key:item.page_key,operation_key:item.operation_key,disposition:'accepted',job:j,created_at:j.created_at,upload:image.asset_id?null:{id:j.id,url:origin+'/v1/uploads/'+j.id+'/content',method:'PUT',headers:{'Content-Type':'image/png'},authorization_required:true,expires_at:'2099-01-01'}};
      operations.set(item.operation_key,op);return op;
    });
    const result={session_id:value.session_id,applied_sequence:value.sequence,priority:Object.fromEntries(value.items.map(i=>[i.mode,{owned:true,epoch:1,expires_at:'2099-01-01'}])),items,policy_revision:policy(),entitlements:rights,image_rate_limit:rights.image_rate_limit};
    if(state.unknown){state.unknown=false;throw Error('Fixture response lost after acceptance');}
    return json(result,items.some(i=>i.disposition==='accepted')?202:200);
  }
  if(url.pathname==='/v1/translation-operations/resolve')return json({items:body.operation_keys.map((key:string)=>operations.has(key)?receipt(operations.get(key)!):{operation_key:key,disposition:'not_found'}),policy_revision:policy()});
  if(url.pathname==='/v1/translation-operations')return json({items:[...operations.values()].map(receipt),total:operations.size,next_offset:null});
  if(url.pathname.endsWith('/lease'))return json({session_id:url.pathname.split('/')[3],priority:Object.fromEntries(body.modes.map((mode:string)=>[mode,{owned:true,epoch:1,expires_at:'2099-01-01'}])),policy_revision:policy()});
  if(url.pathname.startsWith('/v1/uploads/')&&url.pathname.endsWith('/content'))return new Response(null,{status:204});
  if(url.pathname.startsWith('/v1/uploads/')&&url.pathname.endsWith('/complete')){const j=jobs.get(url.pathname.split('/')[3])!;j.status='validating_upload';return json(j);}
  if(url.pathname==='/v1/me/translation-changes'){
    for(const j of jobs.values()){
      if(j.status==='validating_upload'){j.status=autoScenario?'running':'queued';j.input_asset_id='asset-'+j.page_index;}
      if(j.id.startsWith('submitted-')&&['queued','running'].includes(j.status)&&['success','failure'].includes(redrawOutcome??'')){
        const count=(redrawPolls.get(j.id)??0)+1;redrawPolls.set(j.id,count);j.status=count<3?'running':redrawOutcome==='success'?'succeeded':'failed';
        if(j.status==='succeeded')j.output_asset_id='output-'+j.id;
        if(j.status==='failed')j.error={code:'FIXTURE_FAILURE',message:'模拟处理失败，已有译图仍可阅读。'};
      }
    }
    const revision=()=>{const snapshot=JSON.stringify([...jobs.values()]);if(snapshot!==previousJobs){previousJobs=snapshot;changeRevision++;}return changeRevision;};
    const cursor=Number(url.searchParams.get('cursor')??0),end=performance.now()+Number(url.searchParams.get('wait_seconds')??0)*1000;
    while(revision()===cursor&&url.searchParams.get('policy_revision')===policy()&&performance.now()<end){if(init.signal?.aborted)throw new DOMException('Aborted','AbortError');await new Promise(r=>setTimeout(r,25));}
    return json({items:revision()>cursor?[...jobs.values()]:[],deleted_job_ids:[],cursor:String(changeRevision),has_more:false,policy_revision:policy(),entitlements:rights,image_rate_limit:rights.image_rate_limit});
  }
  if(url.pathname.endsWith('/access'))return json({url:`${origin}/v1/fixture-output`,expires_at:'2099-01-01T00:00:00Z'});
  if(url.pathname==='/v1/fixture-output'){state.downloadedAt=performance.now();return new Response(blob);}
  if(url.pathname.endsWith('/cancel')){const id=url.pathname.split('/')[3];const j=jobs.get(id)!;j.status='cancelled';return json(j);}
  if(url.pathname==='/v1/me/feedback')return json({items:[],total:0});
  return json({error:{code:'FIXTURE_ROUTE_MISSING',message:`Unimplemented fixture route: ${url.pathname}`}},404);
};
if(!autoScenario)await editLibrary((_library,copies)=>{for(const copy of copies)for(const page of copy.pages)delete page.imageSha256;});
await import('../src/main');
if(new URLSearchParams(location.search).has('directory')){const output=document.createElement('output');output.id='fixture-requests';output.style.cssText='position:fixed;bottom:0;right:0;z-index:100;font-size:10px;background:#fff;color:#555;padding:2px 6px';document.body.append(output);setInterval(()=>{output.textContent=`隔离验收 · 新翻译 ${state.submitted.length} 页 · 阅读计划 ${state.requests.filter(p=>p==='/v1/translation-plans').length} 次`;},500);}
if(flow){const output=document.createElement('output');output.id='fixture-flow-state';output.style.cssText='position:fixed;bottom:0;right:0;z-index:100;font-size:10px;background:#fff;color:#555;padding:2px 6px';document.body.append(output);setInterval(async()=>{const s=await readLibrary();output.textContent=`隔离验收 · 已读：${s.chapters.filter(c=>c.title.startsWith(`连读 ${flow}`)&&c.readAt).map(c=>c.number).join('、')||'无'} · 解码 ${document.querySelector('.nc-reading-viewport')?.getAttribute('data-decoded-pages')??0} 页 · 新翻译 ${state.submitted.length} 页`;},500);}

if(autoScenario||new URLSearchParams(location.search).has('controls')){
 const panel=document.createElement('div');panel.style.cssText='position:fixed;bottom:0;right:0;z-index:100;background:#fff;color:#555;padding:4px;font-size:11px';
 const output=document.createElement('output');panel.append(output);
 for(const [label,status] of [['模拟完成','succeeded'],['模拟失败','failed']] as const){const button=document.createElement('button');button.textContent=label;button.onclick=()=>{for(const j of jobs.values())if(['queued','running','validating_upload'].includes(j.status)){j.status=status;j.updated_at=new Date().toISOString();if(status==='succeeded')j.output_asset_id='output-'+j.id;else j.error={code:'FIXTURE_FAILURE',message:'模拟翻译失败，点击重试'};}};panel.append(button);}
 const upgrade=document.createElement('button');upgrade.textContent='模拟权益恢复';upgrade.onclick=()=>{rights.modes.classic.quota!.available=100;window.dispatchEvent(new Event('focus'));};panel.append(upgrade);
 document.body.append(panel);
 setInterval(()=>{output.textContent=`新提交 ${state.submitted.length} 张 [${state.submitted.map(n=>n+1).join(',')}] · 在途 ${activeCount()} · `;},200);
}

if(autoScenario==='pipeline'){
 const tools=document.createElement('div');tools.style.cssText='position:fixed;bottom:0;right:0;z-index:1000;background:white;color:#222;padding:8px';
 const finish=document.createElement('button');finish.textContent='完成下一页（隔离验收）';finish.onclick=()=>state.finishNext();
 const output=document.createElement('output');output.id='pipeline-metrics';
 tools.append(finish,output);document.body.append(tools);
 setInterval(()=>{output.textContent=` 提交 ${state.submitted.length} 页 · 更新请求 ${state.requests.filter(p=>p==='/v1/me/translation-changes').length} · 完成到下载 ${state.completedAt&&state.downloadedAt>=state.completedAt?(state.downloadedAt-state.completedAt).toFixed(0)+' ms':'等待'}`;},100);
}
