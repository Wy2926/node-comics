import {billingOffer} from './billing-fixture-data';
import {saveSession,readAuth} from '../src/auth/storage';
import {initializeUiLanguage} from '../src/i18n/load';
import type {Session} from '../src/auth/model';
/** Isolated UI fixture: synthetic account and responses; no external requests. */
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {App} from '../src/App';
import {API_ORIGIN} from '../src/service';
import type {Entitlements} from '../src/types';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';
if(location.port!=='5186')throw Error('Use isolated port 5186 for this fixture.');
await initializeUiLanguage();
const params=new URLSearchParams(location.search);
let scenario=params.get('scenario')??'plus';
let failSync=params.get('syncError')==='1';
const session:Session={id:crypto.randomUUID(),expiresAt:Date.now()+3600000,refreshAt:Date.now()+3540000,credential:{kind:'development'},token:'synthetic-fixture',apiOrigin:API_ORIGIN,user:{id:'fixture-reader',name:'星野 · 漫画爱好者',role:'reader'}};
if((await readAuth()).session&&!localStorage.getItem('nc-account-fixture'))throw Error('Existing session: refusing to seed.');
localStorage.setItem('nc-account-fixture','true');
await saveSession(scenario==='guest'?null:session);
function rights():Entitlements {
 const plus=!['free','exhausted'].includes(scenario);
 return {plan:plus?'plus':'free',plus_started_at:null,plus_expires_at:plus?'2026-10-20T00:00:00Z':null,timezone:'Asia/Shanghai',image_rate_limit:{limit:plus?100:30,window_seconds:60},scheduler_weight:1,pending_previous_period_pages:0,generated_at:new Date().toISOString(),modes:{classic:{allowed:true,unlimited:plus,quota_kind:plus?'classic_unlimited':'classic_daily',consent_version:'1',quota:plus?null:{id:'fixture-classic',kind:'classic_daily',granted:100,available:scenario==='exhausted'?0:76,used:scenario==='exhausted'?100:22,reserved:scenario==='exhausted'?0:2,starts_at:'2026-09-19T16:00:00Z',resets_at:'2026-09-20T16:00:00Z',next_expiry_at:'2026-09-20T16:00:00Z',buckets:[]}},redraw:{allowed:plus,unlimited:false,quota_kind:'redraw_monthly',consent_version:'1',quota:plus?{id:'fixture',kind:'redraw_monthly',granted:300,available:268,used:30,reserved:2,starts_at:'2026-09-20',resets_at:'2026-10-20',next_expiry_at:'2026-10-20',buckets:[]}:null}}};
}
const monthly={...billingOffer,channels:billingOffer.channels.filter(c=>c.provider==='stripe')};
const annual={...monthly,id:'fixture-annual',interval:'year' as const,unit_amount:9999};
window.fetch=async(input)=>{
 const url=new URL(String(input),location.href),path=url.pathname;
 if(url.origin!==API_ORIGIN)throw Error('External requests disabled in fixture.');
 if(path==='/v1/auth/config')return Response.json({mode:'oidc',dev_auth:false});
 if(path==='/v1/capabilities')return Response.json({modes:[],languages:[{id:'zh-Hans',label:'简体中文'}],limits:{},entitlements:rights(),retention_days:0});
 const billing={offers:[monthly,annual],checkout_price:null,enabled:true,providers:[{id:'stripe',label:'Stripe',environment:'test'},{id:'creem',label:'Creem',environment:'test'}],provider:'stripe',environment:'test',checkout_provider:null,trial_eligible:['free','exhausted'].includes(scenario),entitlement_expires_at:null,checkout_pending:false,subscription:['free','exhausted'].includes(scenario)?null:{provider:'stripe',price:billingOffer,status:'active',next_billed_at:'2026-10-20T00:00:00Z',paid_ends_at:'2026-10-20T00:00:00Z',trial_ends_at:null,cancel_at:null}};
 if(path==='/v1/billing/catalog')return Response.json({enabled:true,offers:billing.offers});
 if(path==='/v1/billing/status')return Response.json(billing);
 if(path==='/v1/billing/sync')return failSync?Response.json({error:{message:'模拟刷新失败'}},{status:503}):Response.json({billing,entitlements:rights()});
 if(path==='/v1/billing/checkouts')return Response.json({checkout_url:'https://checkout.stripe.com/c/pay/cs_test_fixture',trial:true,environment:'test',provider:'stripe'});
 if(path==='/v1/billing/portal')return Response.json({url:'https://billing.stripe.com/p/session/fixture',provider:'stripe'});
 if(path==='/v1/me/entitlements')return Response.json(rights());
 if(path==='/v1/me/usage/summary'){
  if(scenario==='error')return Response.json({error:{message:'模拟网络失败，请重试'}},{status:503});
  if(scenario==='loading')await new Promise(resolve=>setTimeout(resolve,4000));
  const count=Number(url.searchParams.get('days')??7),empty=scenario==='empty';
  const days=Array.from({length:count},(_,n)=>({date:new Date(Date.UTC(2026,8,20-count+n+1)).toISOString().slice(0,10),classic:empty?0:n%4+2,redraw:empty?0:n%3,delivered:empty?0:n%4+2+n%3}));
  return Response.json({entitlements:rights(),days,start_date:days[0].date,end_date:days.at(-1)!.date,timezone:'Asia/Shanghai',delivered:days.reduce((n,d)=>n+d.delivered,0),by_mode:{classic:days.reduce((n,d)=>n+d.classic,0),redraw:days.reduce((n,d)=>n+d.redraw,0)},included_delivered:empty?0:12,free_delivered:0,quota_used:{redraw:empty?0:6}});
 }
 if(path==='/v1/me/feedback')return Response.json({items:[],total:0,next_offset:null});
 throw Error('Unexpected fixture request: '+path);
};
if(!location.hash)location.hash='account';
function Fixture(){
 const [version,setVersion]=useState(0),[syncError,setSyncError]=useState(false),[narrow,setNarrow]=useState(false);
 return <>
  <div style={{padding:8,display:'flex',flexWrap:'wrap',gap:12,background:'#edf2fc',color:'#202d43'}}>
   <b>隔离验收 · 模拟数据</b>
   {[['plus','PLUS'],['free','普通'],['exhausted','额度耗尽'],['error','失败'],['loading','加载'],['empty','零用量'],['guest','未登录']].map(([value,label])=><button key={value} onClick={async()=>{scenario=value;await saveSession(value==='guest'?null:session);location.hash='account';setVersion(v=>v+1);}}>{label}</button>)}
   <button onClick={()=>{failSync=!failSync;setSyncError(failSync);}}>权益刷新：{syncError?'失败':'成功'}</button>
   <button onClick={()=>setNarrow(v=>!v)}>{narrow?'宽屏':'窄屏'}</button>
  </div>
  {narrow?<iframe key={version+':'+syncError} title="窄屏账户验收" src={'?embedded=1&scenario='+scenario+'&syncError='+(syncError?'1':'0')} style={{width:390,height:850,border:0,display:'block',margin:'0 auto'}}/>:<App key={version}/>}
 </>;
}
createRoot(document.getElementById('root')!).render(location.search.includes('embedded=1')?<App/>:<Fixture/>);
