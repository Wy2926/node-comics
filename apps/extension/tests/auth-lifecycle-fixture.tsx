/** Isolated, synthetic identity provider and product API; no external traffic. */
import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import {App} from '../src/App';
import {Api} from '../src/api';
import {API_BASE,API_ORIGIN} from '../src/service';
import {sessionAuthorization} from '../src/auth/session';
import {authKey,readAuth,saveSession,subscribeAuth} from '../src/auth/storage';
import {tokenLifetime,type Session} from '../src/auth/model';
import {readCopies,commitCopies,putBlob} from '../src/library/store';
import {makeCopy} from '../src/library/model';
import {emptyPage} from '../src/reader/model';
import type {Entitlements} from '../src/types';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5187')throw Error('Use isolated http://127.0.0.1:5187.');
const existing=await readCopies(),saved=(await readAuth()).session;
if(existing.some(c=>!c.id.startsWith('auth-fixture-'))||saved&&!saved.user.id.startsWith('fixture-'))throw Error('This origin contains non-fixture data.');
const nativeFetch=window.fetch.bind(window),endpoint='https://fixture-identity.invalid/token';
const image=await(await nativeFetch('/samples/starlight-bookshop.png')).blob();
if(!existing.length){
  const bitmap=await createImageBitmap(image),pages=Array.from({length:3},(_,i)=>({...emptyPage(`验收第 ${i+1} 页`,bitmap.width,bitmap.height),id:`auth-fixture-page-${i}`,blobKey:'auth-fixture-original'}));bitmap.close();
  await putBlob('auth-fixture-original',image);await commitCopies([{...makeCopy('会话过期时继续阅读',pages,'隔离验收'),id:'auth-fixture-comic'}],[{title:'会话过期时继续阅读',kind:'work'}]);
}
const makeSession=(name='账户 A'):Session=>({id:'auth-fixture-'+crypto.randomUUID(),token:'fixture-access',...tokenLifetime(3600),user:{id:'fixture-'+name,name,role:'reader'},apiOrigin:API_ORIGIN,credential:{kind:'oidc',refreshToken:'fixture-refresh',tokenEndpoint:endpoint,clientId:'fixture-client',resource:API_ORIGIN}});
if(!localStorage.getItem(authKey))await saveSession(makeSession());
let mode:'ok'|'offline'|'revoked'|'401'|'403'='ok',refreshes=0,requests=0,status='就绪';
const changed=()=>window.dispatchEvent(new Event('auth-fixture-metrics'));
const rights=():Entitlements=>({plan:'free',plus_started_at:null,plus_expires_at:null,timezone:'Asia/Shanghai',image_rate_limit:{limit:30,window_seconds:60},scheduler_weight:1,pending_previous_period_pages:0,generated_at:new Date().toISOString(),modes:{classic:{allowed:true,unlimited:true,quota_kind:'classic_daily',consent_version:'fixture',quota:null},redraw:{allowed:false,unlimited:false,quota_kind:'redraw_monthly',consent_version:'fixture',quota:null}}});
window.fetch=async(input,init)=>{
  const url=new URL(String(input),location.href);
  if(url.href===endpoint){refreshes++;changed();if(mode==='offline')throw TypeError('Fixture offline');if(mode==='revoked')return Response.json({error:'invalid_grant'},{status:400});return Response.json({access_token:'fixture-access-'+refreshes,refresh_token:'fixture-refresh-'+refreshes,token_type:'Bearer',expires_in:3600});}
  if(url.origin!==API_ORIGIN)throw Error('External traffic disabled.');
  requests++;changed();
  if(url.pathname==='/v1/auth/config')return Response.json({mode:'development',dev_auth:true});
  if(url.pathname==='/v1/auth/dev'){const {username}=JSON.parse(String(init?.body));return Response.json({access_token:'fixture-dev',expires_in:43200,user:{id:'fixture-'+username,name:username,role:'reader'}});}
  const token=new Headers(init?.headers).get('Authorization');
  if(token&&mode==='401')return Response.json({error:{code:'TOKEN_INVALID',message:'模拟认证失效'}},{status:401});
  if(token&&mode==='403')return Response.json({error:{code:'FORBIDDEN',message:'模拟业务权限不足'}},{status:403});
  if(url.pathname==='/v1/capabilities')return Response.json({modes:[],languages:[{id:'zh-Hans',label:'简体中文'}],limits:{},entitlements:token?rights():null,retention_days:0});
  if(url.pathname==='/v1/me/entitlements')return Response.json(rights());
  if(url.pathname==='/v1/me/usage/summary')return Response.json({entitlements:rights(),days:[],start_date:'2026-09-20',end_date:'2026-09-20',timezone:'Asia/Shanghai',delivered:0,by_mode:{classic:0,redraw:0},included_delivered:0,free_delivered:0,quota_used:{redraw:0}});
  if(url.pathname==='/v1/me/feedback')return Response.json({items:[],total:0,next_offset:null});
  if(url.pathname==='/v1/translation-operations/resolve')return Response.json({items:[]});
  if(url.pathname==='/v1/me/translation-changes'){
    if(url.searchParams.has('wait_seconds'))await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,1000);init?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});});
    return Response.json({items:[],deleted_job_ids:[],cursor:'0',has_more:false});
  }
  throw Error('Unexpected fixture route: '+url.pathname);
};
async function probe(){try{const session=(await readAuth()).session;if(!session)throw Error('未登录');await new Api(API_BASE,session.token,undefined,undefined,sessionAuthorization(session.id)).entitlements();status='请求成功';}catch(e){status=(e as Error).message;}changed();}
async function expire(next:typeof mode){mode=next;const session=(await readAuth()).session;if(session)await saveSession({...session,refreshAt:Date.now()-2000,expiresAt:Date.now()-1000,retryAt:undefined});await probe();}
function Fixture(){
  const [,render]=useState(0);useEffect(()=>{const update=()=>render(n=>n+1);window.addEventListener('auth-fixture-metrics',update);const unsubscribe=subscribeAuth(update);return()=>{unsubscribe();window.removeEventListener('auth-fixture-metrics',update);};},[]);
  return <><div style={{padding:12,background:'#eff3ff',display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}><b>隔离验收 · 模拟身份服务</b><button onClick={()=>void expire('ok')}>模拟到期续期</button><button onClick={()=>void expire('offline')}>模拟断网到期</button><button onClick={()=>void expire('revoked')}>模拟授权撤销</button><button onClick={()=>{mode='401';void probe();}}>持续 401</button><button onClick={()=>{mode='403';void probe();}}>业务 403</button><button onClick={()=>{mode='ok';void saveSession(makeSession('账户 B'));}}>登录账户 B</button><button onClick={()=>void probe()}>读取账户</button><span>续期 {refreshes} 次 · 请求 {requests} 次 · {status}</span></div><App/></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
