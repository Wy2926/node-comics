/** Isolated UI fixture: synthetic identity and responses; no external requests. */
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {App} from '../src/App';
import {saveSession,readAuth} from '../src/auth/storage';
import type {Session} from '../src/auth/model';
import {initializeUiLanguage} from '../src/i18n/load';
import {saveSettings} from '../src/comics/application/preferences';
import {API_ORIGIN} from '../src/service';
import {defaults,type Entitlements,type Settings} from '../src/types';
import {purchaseFixtures} from './quota-purchases-fixture-data';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if(location.origin!=='http://127.0.0.1:5186')throw Error('Use isolated port 5186.');
const params=new URLSearchParams(location.search);
let scenario=params.get('scenario')??'member';
let failPurchases=params.get('purchaseError')==='1',failEntitlements=false;
const requests:string[]=[];
const session:Session={id:crypto.randomUUID(),expiresAt:Date.now()+3600000,refreshAt:Date.now()+3540000,credential:{kind:'development'},token:'synthetic-fixture',apiOrigin:API_ORIGIN,user:{id:'fixture-reader',name:'星野 · 漫画爱好者',role:'reader'}};
if((await readAuth()).session&&!localStorage.getItem('nc-account-fixture'))throw Error('Existing session: refusing to seed.');
localStorage.setItem('nc-account-fixture','true');
await saveSettings({...defaults,uiLanguage:(params.get('locale')??'zh-CN') as Settings['uiLanguage'],appearance:params.get('theme')==='dark'?'dark':'light',accentTheme:(params.get('accent')??'sky') as Settings['accentTheme'],textScale:params.has('largeText')?1.25:1});
await initializeUiLanguage();
await saveSession(scenario==='guest'?null:session);
Object.assign(window,{accountFixture:{requests,setPurchaseError:(value:boolean)=>{failPurchases=value;},setEntitlementError:(value:boolean)=>{failEntitlements=value;}}});
function rights():Entitlements{
  const member=scenario==='member';
  return {plan:member?'fixture-paid':'free',plan_name:member?'示例会员':'free',service_plan:member?'fixture-paid':'free',
    plus_started_at:member?'2026-10-01T00:00:00Z':null,plus_expires_at:member?'2027-01-01T00:00:00Z':null,
    timezone:'Asia/Shanghai',generated_at:new Date().toISOString(),pending_previous_period_pages:0,image_rate_limit:{limit:member?100:10,window_seconds:60},
    free_quota:{granted:30,used:22,reserved:2,available:6,resets_at:'2026-10-09T16:00:00Z',next_expiry_at:'2026-10-09T16:00:00Z'},
    subscription_quota:{granted:member?4000:0,used:member?420:0,reserved:member?3:0,available:member?3577:0,unlimited:false,resets_at:member?'2026-11-01T00:00:00Z':null,next_expiry_at:member?'2026-11-01T00:00:00Z':null},
    purchase_quota:scenario==='empty'?{granted:0,used:0,reserved:0,available:0,next_expiry_at:null}:{granted:4500,used:540,reserved:15,available:3945,next_expiry_at:'2026-10-31T03:00:00Z'},
    modes:{classic:{allowed:true,unlimited:false,quota_kind:member?'classic_monthly':'classic_daily',consent_version:'fixture',quota:null}}};
}
window.fetch=async(input,init)=>{
  const url=new URL(String(input),location.href),path=url.pathname;
  if(url.origin!==API_ORIGIN)throw Error('External requests disabled in fixture.');
  requests.push(path+url.search);
  if(path==='/v1/auth/config')return Response.json({mode:'oidc',dev_auth:false});
  if(path==='/v1/capabilities')return Response.json({result_protocol:'overlay-v1',modes:[],languages:[],limits:{},entitlements:rights()});
  if(path==='/v1/me/entitlements')return failEntitlements?Response.json({error:{message:'Synthetic entitlement failure'}},{status:503}):Response.json(rights());
  if(path==='/v1/me/quota-purchases'){
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};
      const timer=setTimeout(()=>{init?.signal?.removeEventListener('abort',abort);resolve();},params.has('slowPurchases')?1500:120);
      if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
    });
    if(failPurchases)return Response.json({error:{message:'Synthetic purchase history failure'}},{status:503});
    const items=scenario==='empty'?[]:purchaseFixtures;
    const cursor=url.searchParams.get('cursor'),start=cursor?items.findIndex(item=>item.id===cursor)+1:0;
    const rows=items.slice(start,start+20);
    return Response.json({items:rows,next_cursor:start+20<items.length?rows.at(-1)!.id:null});
  }
  if(path==='/v1/me/usage/summary')return Response.json({entitlements:rights(),days:[],start_date:'2026-10-03',end_date:'2026-10-09',timezone:'Asia/Shanghai',delivered:420,by_mode:{classic:420},included_delivered:420,free_delivered:0,quota_used:{classic:420}});
  if(path==='/v1/me/feedback')return Response.json({items:[],total:0,next_offset:null});
  throw Error('Unexpected fixture request: '+path);
};
if(!location.hash)location.hash='account';
function Fixture(){
  const [version,setVersion]=useState(0);
  return <>
    <div style={{padding:8,display:'flex',flexWrap:'wrap',gap:12,background:'#edf2fc',color:'#202d43'}}>
      <b>隔离验收 · 模拟数据</b>
      {[['member','示例会员'],['packs','仅额度包'],['empty','无额度包'],['guest','未登录']].map(([value,label])=><button key={value} onClick={async()=>{scenario=value;await saveSession(value==='guest'?null:session);location.hash='account';setVersion(v=>v+1);}}>{label}</button>)}
    </div>
    <App key={version}/>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
