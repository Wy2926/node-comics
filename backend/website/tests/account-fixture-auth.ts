import type {Billing,BillingOffer} from '../src/lib/billing';
import {ApiError} from '../src/lib/auth-session';
export {ApiError};
const plusMonth:BillingOffer={id:'old-plus-month',name:'PLUS 示例',plan_id:'plus',plan_revision_id:'plus-v1',currency:'usd',unit_amount:999,interval:'month',monthly_classic_pages:300,trial_days:7,trial_classic_pages:30,channels:[{provider:'stripe',binding_id:'stripe-fixture',trial_days:7,trial_classic_pages:30},{provider:'creem',binding_id:'creem-fixture',trial_days:7,trial_classic_pages:30}]};
const plusAnnual:BillingOffer={...plusMonth,id:'old-plus-year',unit_amount:9999,interval:'year'};
const month:BillingOffer={...plusMonth,id:'fixture-month',name:'Lite',plan_id:'lite',plan_revision_id:'lite-v1',unit_amount:599,monthly_classic_pages:null,hourly_image_limit:1200,trial_classic_pages:null,channels:plusMonth.channels.map(channel=>({...channel,trial_classic_pages:null}))};
const annual:BillingOffer={...month,id:'fixture-year',unit_amount:5999,interval:'year'};
const pack:BillingOffer={...month,id:'fixture-pack',name:'Lite 100 页',plan_id:'pages',service_plan_id:'lite',interval:'once',quota_pages:100,quota_validity_days:null,monthly_classic_pages:0,trial_days:0,trial_classic_pages:0,channels:month.channels.map(channel=>({...channel,trial_days:0,trial_classic_pages:0}))};
const entitlements={plan:'free',plus_expires_at:null,image_rate_limit:{limit:10},modes:{classic:{unlimited:false,allowed:true,quota:{available:30,granted:30,reserved:0}}}};
const parameters=new URLSearchParams(location.search);
const scenario=parameters.get('scenario');
const pending=parameters.has('pending')||scenario==='subscription-pending';
const subscriptionProvider='creem';
const billing:Billing={enabled:true,providers:[{id:'stripe',label:'Stripe',environment:'test'},{id:'creem',label:'Creem',environment:'test'}],provider:null,environment:'test',trial_eligible:true,gift:null,entitlement_expires_at:null,
  subscription_checkout:pending?{id:'fixture-subscription-checkout',provider:subscriptionProvider,price:{...annual,channels:annual.channels.filter(channel=>channel.provider===subscriptionProvider)},idempotency_key:null,error:null}:null,
  offers:[month,annual,plusMonth,plusAnnual],subscription:null};
const performanceCheck=parameters.has('perf');
const fixtureStarted=performance.now();
const observations:{accountVisibleMs:number|null;requests:{path:string;startedMs:number;finishedMs?:number}[]}={accountVisibleMs:null,requests:[]};
function report(){
  const output=document.getElementById('account-fixture-observation');
  if(output)output.textContent=JSON.stringify(observations,null,2);
}
export function observeAccountFixture(){
  if(!performanceCheck)return()=>{};
  report();
  const observer=new MutationObserver(()=>{
    if(observations.accountVisibleMs===null&&document.querySelector('.account-summary')){
      observations.accountVisibleMs=Math.round(performance.now()-fixtureStarted);report();
    }
  });
  observer.observe(document.getElementById('root')!,{childList:true,subtree:true});
  return()=>observer.disconnect();
}
if(scenario?.startsWith('quota')||scenario==='subscription-pending'){
  billing.quota_offers=[pack,{...pack,id:'fixture-pack-expiring',name:'Lite 50 页',quota_pages:50,quota_validity_days:30}];
  Object.assign(entitlements,{service_plan:scenario==='quota-depleted'?'free':'lite',purchase_quota:{granted:100,used:scenario==='quota-depleted'?100:10,reserved:0,available:scenario==='quota-depleted'?0:90,next_expiry_at:null}});
  if(scenario==='quota-unknown'||scenario==='quota-retired'){
    const price=scenario==='quota-retired'?'fixture-retired':pack.id;
    localStorage.setItem(`nc-quota-purchase:synthetic-1:${price}`,JSON.stringify({price,provider:'creem',key:'fixture-original-purchase'}));
  }
  if(scenario==='quota-member'){entitlements.plan='lite';entitlements.modes.classic.unlimited=true;billing.subscription={provider:'creem',price:annual,status:'active',next_billed_at:null,cancel_at:null,trial_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null,paid_ends_at:'2099-01-01T00:00:00Z'};}
}
if(scenario==='expired'||scenario==='revoked'){
  billing.subscription={provider:'creem',price:plusAnnual,status:scenario==='expired'?'expired':'canceled',next_billed_at:null,cancel_at:null,trial_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null,paid_ends_at:'2099-01-01T00:00:00Z'};
  billing.provider='creem';billing.trial_eligible=false;
}
if(scenario==='active'||scenario==='canceling'){
  entitlements.plan='plus';
  Object.assign(entitlements,{plus_expires_at:'2099-01-01T00:00:00Z'});
  billing.entitlement_expires_at='2099-01-01T00:00:00Z';
  billing.subscription={provider:'stripe',price:plusAnnual,status:scenario==='active'?'active':'scheduled_cancel',next_billed_at:scenario==='active'?'2099-01-01T00:00:00Z':null,cancel_at:scenario==='canceling'?'2099-01-01T00:00:00Z':null,trial_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null,paid_ends_at:'2099-01-01T00:00:00Z'};
}
if(scenario==='lite'){
  Object.assign(entitlements,{plan:'lite',plus_expires_at:'2099-01-01T00:00:00Z',hourly_image_rate_limit:{window_seconds:3600,limit:1200}});
  billing.entitlement_expires_at='2099-01-01T00:00:00Z';
  billing.subscription={provider:'creem',price:annual,status:'active',next_billed_at:'2099-01-01T00:00:00Z',cancel_at:null,trial_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null,paid_ends_at:'2099-01-01T00:00:00Z'};
}
if(scenario==='disabled')billing.enabled=false;
if(scenario==='canceling'&&billing.subscription)Object.assign(billing.subscription,{auto_renew:false,can_cancel:false,renewal_state:'canceled'});
if(scenario?.startsWith('gift-')){
  const state=scenario==='gift-pending'?'pending':scenario==='gift-scheduled'?'scheduled':'active';
  const start=new Date(Date.now()+(state==='active'?-2:12)*86400000).toISOString(),end=new Date(Date.parse(start)+30*86400000).toISOString();
  billing.gift={days:30,state,starts_at:state==='pending'?null:start,ends_at:state==='pending'?null:end};
  entitlements.plan='plus';Object.assign(entitlements,{plus_expires_at:end,gift:billing.gift});
  if(scenario!=='gift-only')billing.subscription={provider:'creem',price:plusAnnual,status:state==='active'?'paused':'active',next_billed_at:start,cancel_at:null,trial_ends_at:null,paid_ends_at:start,auto_renew:true,can_cancel:true,renewal_state:state==='pending'?'deferring':'deferred',resume_at:billing.gift.ends_at};
  if(scenario==='gift-canceling'&&billing.subscription)Object.assign(billing.subscription,{renewal_state:'canceling',auto_renew:false,can_cancel:false});
  if(scenario==='gift-attention'&&billing.subscription)billing.subscription.renewal_state='attention';
  if(scenario==='gift-resuming'&&billing.subscription)billing.subscription.renewal_state='resuming';
}
billing.provider=billing.subscription?.provider??null;
let loggedIn=scenario!=='signed-out'&&scenario!=='quota-signed-out';
let accountVersion=1;
const authChanges=new EventTarget();
export const session=async()=>loggedIn?{}:null;
export const sessionIdentity=async()=>loggedIn?{id:'synthetic-session-'+accountVersion,subject:'synthetic-subject-'+accountVersion}:null;
export const subscribeAuth=(listener:()=>void)=>{authChanges.addEventListener('change',listener);return()=>authChanges.removeEventListener('change',listener);};
export const switchFixtureAccount=()=>{accountVersion++;loggedIn=true;authChanges.dispatchEvent(new Event('change'));};
export const signIn=async(path?:string)=>{const output=document.getElementById('checkout-observation');if(output)output.textContent=`模拟登录返回：${path}`;};
export const signOut=async()=>{loggedIn=false;authChanges.dispatchEvent(new Event('change'));};
export const finishLogin=async()=>{};
export const loginReturnPath=()=>'/account/';
export const fixtureCatalog=()=>({offers:billing.offers.filter(offer=>offer.plan_id==='lite'),quota_offers:billing.quota_offers??[]});
let endedKey:string|undefined;
export async function api<T>(path:string,_method?:string,body?:unknown,headers?:Record<string,string>):Promise<T>{
  const version=accountVersion;
  if(performanceCheck){
    const record={path,startedMs:Math.round(performance.now()-fixtureStarted),finishedMs:undefined as number|undefined};
    observations.requests.push(record);report();
    const parameter=path==='/v1/me'?'meDelay':path==='/v1/billing/status'?'statusDelay':path==='/v1/billing/sync'?'syncDelay':null;
    const delay=parameter?Number(parameters.get(parameter)||0):0;
    if(Number.isFinite(delay)&&delay>0)await new Promise(resolve=>setTimeout(resolve,Math.min(delay,30000)));
    record.finishedMs=Math.round(performance.now()-fixtureStarted);report();
    if(!loggedIn||version!==accountVersion)throw new ApiError('登录已变更',401);
    if(path==='/v1/billing/sync'&&parameters.has('syncFail'))throw new ApiError('模拟支付同步超时，已有权益不受影响。',503);
  }
  if(path==='/v1/me')return {user:{id:'synthetic-'+version,name:version===1?'界面验收':'界面验收 '+version},entitlements} as T;
  if(path==='/v1/billing/status'){if(scenario==='error')throw new ApiError('账户服务暂时不可用，请重试。',503);return structuredClone(billing) as T;}
  if(path==='/v1/billing/sync')return structuredClone({billing,entitlements}) as T;
  if(path==='/v1/billing/checkouts'){
    const message=`已验证报价：${(body as {price_id:string}).price_id} · ${(body as {provider:string}).provider}${headers?.['Idempotency-Key']?' · '+headers['Idempotency-Key']:''}`;
    const output=document.getElementById('checkout-observation');if(output)output.textContent=message+'（模拟响应丢失，不创建真实订单）';
    if(scenario==='quota-expired'){
      const key=headers?.['Idempotency-Key'];
      endedKey??=key;
      if(endedKey===key)throw new ApiError('未付款会话已结束',409,'BILLING_PURCHASE_RETRY_ALLOWED');
    }
    throw new ApiError(message,418);
  }
  if(path==='/v1/billing/portal')throw new ApiError(`已验证订阅管理：${(body as {provider:string}).provider}`,418);
  if(path==='/v1/billing/cancel-renewal'){
    if(!billing.subscription?.can_cancel||(body as {provider:string}).provider!==billing.subscription.provider)throw new ApiError('重复或无效取消',409);
    billing.subscription={...billing.subscription,auto_renew:false,can_cancel:false,renewal_state:'canceled',resume_at:null,next_billed_at:null};
    if(scenario==='gift-cancel-lost')throw new ApiError('账户服务暂时不可用，请重试。',503);
    return {...billing} as T;
  }
  throw Error('No external requests allowed in this fixture');
}
