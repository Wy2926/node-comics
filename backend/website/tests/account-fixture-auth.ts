import type {Billing,BillingOffer} from '../src/lib/billing';
export class ApiError extends Error {constructor(message:string,public status:number){super(message);}}
const month:BillingOffer={id:'fixture-month',name:'PLUS 示例',plan_id:'plus',plan_revision_id:'plus-v1',currency:'usd',unit_amount:999,interval:'month',monthly_redraw_pages:300,trial_days:0,trial_redraw_pages:0,channels:[{provider:'stripe',binding_id:'stripe-fixture',trial_days:7,trial_redraw_pages:30},{provider:'creem',binding_id:'creem-fixture',trial_days:7,trial_redraw_pages:30}]};
const annual:BillingOffer={...month,id:'fixture-year',unit_amount:9999,interval:'year'};
const other:BillingOffer={...month,id:'fixture-light',plan_id:'light',plan_revision_id:'light-v1',name:'Light 示例',unit_amount:499,monthly_redraw_pages:100};
const entitlements={plan:'free',plus_expires_at:null,image_rate_limit:{limit:30},modes:{classic:{unlimited:false,allowed:true,quota:{available:100,granted:100,reserved:0}},redraw:{unlimited:false,allowed:false,quota:null}}};
const pending=new URLSearchParams(location.search).has('pending');
const billing:Billing={enabled:true,providers:[{id:'stripe',label:'Stripe',environment:'test'},{id:'creem',label:'Creem',environment:'test'}],provider:pending?'creem':null,environment:'test',trial_eligible:true,entitlement_expires_at:null,checkout_pending:pending,checkout_provider:pending?'creem':null,checkout_price:pending?annual:null,offers:[month,annual,other],subscription:null};
const scenario=new URLSearchParams(location.search).get('scenario');
if(scenario==='expired'||scenario==='revoked'){
  billing.subscription={provider:'creem',price:annual,status:scenario==='expired'?'expired':'canceled',next_billed_at:null,cancel_at:null,trial_ends_at:null,paid_ends_at:'2099-01-01T00:00:00Z'};
  billing.provider='creem';billing.trial_eligible=false;
}
if(scenario==='active'||scenario==='canceling'){
  entitlements.plan='plus';
  Object.assign(entitlements,{plus_expires_at:'2099-01-01T00:00:00Z'});
  billing.entitlement_expires_at='2099-01-01T00:00:00Z';
  billing.subscription={provider:'stripe',price:annual,status:scenario==='active'?'active':'scheduled_cancel',next_billed_at:scenario==='active'?'2099-01-01T00:00:00Z':null,cancel_at:scenario==='canceling'?'2099-01-01T00:00:00Z':null,trial_ends_at:null,paid_ends_at:'2099-01-01T00:00:00Z'};
}
if(scenario==='disabled')billing.enabled=false;
export const session=async()=>scenario==='signed-out'?null:{};
export const signIn=async()=>{};
export const signOut=async()=>{};
export const finishLogin=async()=>{};
export const loginReturnPath=()=>'/account/';
export async function api<T>(path:string,_method?:string,body?:unknown):Promise<T>{
  if(path==='/v1/me')return {user:{id:'synthetic',name:'界面验收'},entitlements} as T;
  if(path==='/v1/billing/status'){if(scenario==='error')throw new ApiError('账户服务暂时不可用，请重试。',503);return billing as T;}
  if(path==='/v1/billing/sync')return {billing,entitlements} as T;
  if(path==='/v1/billing/checkouts')throw new ApiError(`已验证报价：${(body as {price_id:string}).price_id} · ${(body as {provider:string}).provider}`,418);
  if(path==='/v1/billing/portal')throw new ApiError(`已验证订阅管理：${(body as {provider:string}).provider}`,418);
  throw Error('No external requests allowed in this fixture');
}
