/** Isolated UI fixture: synthetic account and responses; no external requests. */
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {App} from '../src/App';
import {API_ORIGIN} from '../src/service';
import type {Entitlements} from '../src/types';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
if(location.port!=='5186')throw Error('Use isolated port 5186 for this fixture.');
let scenario='plus';
const session={token:'synthetic-fixture',apiOrigin:API_ORIGIN,user:{id:'fixture-reader',name:'星野 · 漫画爱好者',role:'reader'}};
if(localStorage.getItem('nc-session')&&!localStorage.getItem('nc-account-fixture'))throw Error('Existing session: refusing to seed.');
localStorage.setItem('nc-account-fixture','true');
localStorage.setItem('nc-session',JSON.stringify(session));
function rights():Entitlements {
 const plus=scenario!=='free';
 return {plan:plus?'plus':'free',plus_started_at:null,plus_expires_at:plus?'2026-10-20T00:00:00Z':null,timezone:'Asia/Shanghai',image_rate_limit:{limit:plus?100:30,window_seconds:60},scheduler_weight:1,pending_previous_period_pages:0,generated_at:new Date().toISOString(),modes:{classic:{allowed:true,unlimited:plus,quota_kind:'classic_daily',consent_version:'1',quota:null},redraw:{allowed:plus,unlimited:false,quota_kind:'redraw_monthly',consent_version:'1',quota:plus?{id:'fixture',kind:'redraw_monthly',granted:300,available:268,used:30,reserved:2,starts_at:'2026-09-20',resets_at:'2026-10-20',next_expiry_at:'2026-10-20',buckets:[]}:null}}};
}
window.fetch=async(input)=>{
 const url=new URL(String(input),location.href),path=url.pathname;
 if(url.origin!==API_ORIGIN)throw Error('External requests disabled in fixture.');
 if(path==='/v1/auth/config')return Response.json({mode:'oidc',dev_auth:false});
 if(path==='/v1/capabilities')return Response.json({modes:[],languages:[{id:'zh-Hans',label:'简体中文'}],limits:{},entitlements:rights(),retention_days:0});
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
location.hash='account';
function Fixture(){const [version,setVersion]=useState(0);return <><div style={{padding:8,display:'flex',gap:12,background:'#edf2fc',color:'#202d43'}}><b>隔离验收 · 模拟数据</b>{[['plus','PLUS'],['free','普通'],['error','失败'],['loading','加载'],['empty','零用量'],['guest','未登录']].map(([value,label])=><button key={value} onClick={()=>{scenario=value;value==='guest'?localStorage.removeItem('nc-session'):localStorage.setItem('nc-session',JSON.stringify(session));location.hash='account';setVersion(v=>v+1);}}>{label}</button>)}</div><App key={version}/></>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
