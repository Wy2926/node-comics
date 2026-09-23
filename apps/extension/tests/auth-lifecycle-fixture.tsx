/** Isolated, synthetic identity provider and product API; no external traffic. */
import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import {App} from '../src/App';
import {Api} from '../src/api';
import {API_BASE,API_ORIGIN} from '../src/service';
import {sessionAuthorization} from '../src/auth/session';
import {authKey,readAuth,saveSession,subscribeAuth} from '../src/auth/storage';
import {tokenLifetime,type Session} from '../src/auth/model';
import {listLibrary} from '../src/comics/application/library-service';
import {importImageAlbum} from '../src/comics/application/import-service';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {localSourceDriver} from '../src/comics/sources/local/driver';
registerSourceDriver(localSourceDriver);
import type {Entitlements} from '../src/types';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5187')throw Error('Use isolated http://127.0.0.1:5187.');
const existing=await listLibrary(0,1000),saved=(await readAuth()).session;
if(existing.works.some(work=>work.title!=='会话过期时继续阅读')||saved&&!saved.user.id.startsWith('fixture-'))throw Error('This origin contains non-fixture data.');
const nativeFetch=window.fetch.bind(window),endpoint='https://fixture-identity.invalid/token';
const image=await(await nativeFetch('/samples/starlight-bookshop.png')).blob();
if(!existing.works.length){
  await importImageAlbum(Array.from({length:3},(_,index)=>new File([image],`验收第 ${index+1} 页.png`,{type:'image/png'})),{title:'会话过期时继续阅读',kind:'book'});
}
const makeSession=(name='账户 A'):Session=>({id:'auth-fixture-'+crypto.randomUUID(),token:'fixture-access',...tokenLifetime(3600),user:{id:'fixture-'+name,name,role:'reader'},apiOrigin:API_ORIGIN,credential:{kind:'oidc',refreshToken:'fixture-refresh',tokenEndpoint:endpoint,clientId:'fixture-client',resource:API_ORIGIN}});
const loginFixture=new URLSearchParams(location.search).get('login');
if(loginFixture)await saveSession(null);
else if(!localStorage.getItem(authKey))await saveSession(makeSession());
let settleLogin:((success:boolean)=>void)|undefined,loginRequests=0,configRequests=0;
const waitForLogin=()=>new Promise<void>((resolve,reject)=>{loginRequests++;changed();settleLogin=success=>{settleLogin=undefined;success?resolve():reject(Error('登录授权码交换失败（HTTP 503），请重新登录；若仍失败，请联系管理员检查身份服务配置。'));};});
if(loginFixture){
  // Exercise the real OIDC adapter without opening or contacting an external provider.
  Object.assign(chrome,{
    permissions:{contains:async()=>true},
    identity:{getRedirectURL:()=>location.origin+'/fixture-oidc',launchWebAuthFlow:async({url}:{url:string})=>{
      const authorization=new URL(url);await waitForLogin();
      return location.origin+'/fixture-oidc?code=fixture-code&state='+authorization.searchParams.get('state');
    }}
  });
  window.addEventListener('keydown',event=>{if(event.altKey&&(event.code==='KeyS'||event.code==='KeyE')){event.preventDefault();settleLogin?.(event.code==='KeyS');}});
}
let mode:'ok'|'offline'|'revoked'|'401'|'403'='ok',refreshes=0,requests=0,status='就绪';
const changed=()=>window.dispatchEvent(new Event('auth-fixture-metrics'));
const rights=():Entitlements=>({plan:'free',plus_started_at:null,plus_expires_at:null,timezone:'Asia/Shanghai',image_rate_limit:{limit:10,window_seconds:60},scheduler_weight:1,pending_previous_period_pages:0,generated_at:new Date().toISOString(),modes:{classic:{allowed:true,unlimited:true,quota_kind:'classic_daily',consent_version:'fixture',quota:null},redraw:{allowed:false,unlimited:false,quota_kind:'redraw_monthly',consent_version:'fixture',quota:null}}});
window.fetch=async(input,init)=>{
  const url=new URL(String(input),location.href);
  if(url.href===endpoint){refreshes++;changed();if(mode==='offline')throw TypeError('Fixture offline');if(mode==='revoked')return Response.json({error:'invalid_grant'},{status:400});return Response.json({access_token:'fixture-access-'+refreshes,refresh_token:'fixture-refresh-'+refreshes,token_type:'Bearer',expires_in:3600});}
  if(url.origin!==API_ORIGIN)throw Error('External traffic disabled.');
  requests++;changed();
  if(url.pathname==='/v1/auth/config'){
    configRequests++;
    if(loginFixture==='config-error'&&configRequests===1)throw TypeError('Fixture offline');
    if(loginFixture==='loading')await new Promise(resolve=>setTimeout(resolve,8000));
    return Response.json(loginFixture&&loginFixture!=='development'?{mode:'oidc',dev_auth:false,client_id:'fixture-client',authorization_endpoint:'https://fixture-identity.invalid/auth',token_endpoint:endpoint,scopes:'openid profile',audience:API_ORIGIN}:{mode:'development',dev_auth:true});
  }
  if(url.pathname==='/v1/me')return Response.json({user:makeSession().user});
  if(url.pathname==='/v1/auth/dev'){if(loginFixture)await waitForLogin();const {username}=JSON.parse(String(init?.body));return Response.json({access_token:'fixture-dev',expires_in:43200,user:{id:'fixture-'+username,name:username,role:'reader'}});}
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
  return <><div style={{padding:12,background:'#eff3ff',display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}><b>隔离验收 · 模拟身份服务</b>{loginFixture&&<span>登录 {loginRequests} 次 · Alt+S 完成 / Alt+E 失败</span>}<button onClick={()=>void expire('ok')}>模拟到期续期</button><button onClick={()=>void expire('offline')}>模拟断网到期</button><button onClick={()=>void expire('revoked')}>模拟授权撤销</button><button onClick={()=>{mode='401';void probe();}}>持续 401</button><button onClick={()=>{mode='403';void probe();}}>业务 403</button><button onClick={()=>{mode='ok';void saveSession(makeSession('账户 B'));}}>登录账户 B</button><button onClick={()=>void probe()}>读取账户</button><span>续期 {refreshes} 次 · 请求 {requests} 次 · {status}</span></div><App/></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
