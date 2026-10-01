import type {Billing,BillingOffer} from '../src/lib/billing';
export class ApiError extends Error {constructor(message:string,public status:number){super(message);}}
const plusMonth:BillingOffer={id:'old-plus-month',name:'PLUS 示例',plan_id:'plus',plan_revision_id:'plus-v1',currency:'usd',unit_amount:999,interval:'month',monthly_redraw_pages:300,trial_days:7,trial_redraw_pages:30,channels:[{provider:'stripe',binding_id:'stripe-fixture',trial_days:7,trial_redraw_pages:30},{provider:'creem',binding_id:'creem-fixture',trial_days:7,trial_redraw_pages:30}]};
const plusAnnual:BillingOffer={...plusMonth,id:'old-plus-year',unit_amount:9999,interval:'year'};
const month:BillingOffer={...plusMonth,id:'fixture-month',name:'Lite',plan_id:'lite',plan_revision_id:'lite-v1',unit_amount:599,monthly_redraw_pages:0,hourly_image_limit:1200,trial_redraw_pages:0,channels:plusMonth.channels.map(channel=>({...channel,trial_redraw_pages:0}))};
const annual:BillingOffer={...month,id:'fixture-year',unit_amount:5999,interval:'year'};
const entitlements={plan:'free',plus_expires_at:null,image_rate_limit:{limit:10},modes:{classic:{unlimited:false,allowed:true,quota:{available:30,granted:30,reserved:0}},redraw:{unlimited:false,allowed:false,quota:null}}};
const pending=new URLSearchParams(location.search).has('pending');
const billing:Billing={enabled:true,providers:[{id:'stripe',label:'Stripe',environment:'test'},{id:'creem',label:'Creem',environment:'test'}],provider:pending?'creem':null,environment:'test',trial_eligible:true,gift:null,entitlement_expires_at:null,checkout_pending:pending,checkout_provider:pending?'creem':null,checkout_price:pending?annual:null,offers:[month,annual,plusMonth,plusAnnual],subscription:null};
const scenario=new URLSearchParams(location.search).get('scenario');
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
export const session=async()=>scenario==='signed-out'?null:{};
export const signIn=async()=>{};
export const signOut=async()=>{};
export const finishLogin=async()=>{};
export const loginReturnPath=()=>'/account/';
export async function api<T>(path:string,_method?:string,body?:unknown):Promise<T>{
  if(path==='/v1/me')return {user:{id:'synthetic',name:'界面验收'},entitlements} as T;
  if(path==='/v1/billing/status'){if(scenario==='error')throw new ApiError('账户服务暂时不可用，请重试。',503);return structuredClone(billing) as T;}
  if(path==='/v1/billing/sync')return structuredClone({billing,entitlements}) as T;
  if(path==='/v1/billing/checkouts')throw new ApiError(`已验证报价：${(body as {price_id:string}).price_id} · ${(body as {provider:string}).provider}`,418);
  if(path==='/v1/billing/portal')throw new ApiError(`已验证订阅管理：${(body as {provider:string}).provider}`,418);
  if(path==='/v1/billing/cancel-renewal'){
    if(!billing.subscription?.can_cancel||(body as {provider:string}).provider!==billing.subscription.provider)throw new ApiError('重复或无效取消',409);
    billing.subscription={...billing.subscription,auto_renew:false,can_cancel:false,renewal_state:'canceled',resume_at:null,next_billed_at:null};
    if(scenario==='gift-cancel-lost')throw new ApiError('账户服务暂时不可用，请重试。',503);
    return {...billing} as T;
  }
  throw Error('No external requests allowed in this fixture');
}
