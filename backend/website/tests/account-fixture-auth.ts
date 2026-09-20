import type {Billing,BillingOffer} from '../src/lib/billing';
export class ApiError extends Error {constructor(message:string,public status:number){super(message);}}
const month:BillingOffer={id:'fixture-month',name:'PLUS 示例',currency:'usd',unit_amount:999,interval:'month',monthly_redraw_pages:300,trial_days:0,trial_redraw_pages:0};
const annual:BillingOffer={...month,id:'fixture-year',unit_amount:9990,interval:'year'};
const other:BillingOffer={...month,id:'fixture-light',name:'Light 示例',unit_amount:499,monthly_redraw_pages:100};
const entitlements={plan:'free',plus_expires_at:null,image_rate_limit:{limit:30},modes:{classic:{unlimited:false,allowed:true,quota:{available:100,granted:100,reserved:0}},redraw:{unlimited:false,allowed:false,quota:null}}};
const pending=new URLSearchParams(location.search).has('pending');
const billing:Billing={enabled:true,trial_eligible:false,checkout_pending:pending,checkout_price:pending?annual:null,offers:[month,annual,other],subscription:null};
export const session=async()=>({});
export const signIn=async()=>{};
export const signOut=async()=>{};
export const finishLogin=async()=>{};
export const loginReturnPath=()=>'/account/';
export async function api<T>(path:string,_method?:string,body?:unknown):Promise<T>{
  if(path==='/v1/me')return {user:{id:'synthetic',name:'界面验收'},entitlements} as T;
  if(path==='/v1/billing/status')return billing as T;
  if(path==='/v1/billing/sync')return {billing,entitlements} as T;
  if(path==='/v1/billing/checkouts')throw new ApiError(`已验证报价：${(body as {price_id:string}).price_id}`,418);
  throw Error('No external requests allowed in this fixture');
}
