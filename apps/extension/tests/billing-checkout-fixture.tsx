/** No payment requests or real account access; records the exact handoff selected by the UI. */
import {createRoot} from 'react-dom/client';
import type {Api} from '../src/api';
import type {BillingOffer,BillingProvider,BillingStatus} from '../src/billing';
import {MembershipCard} from '../src/ui/MembershipCard';
import {billingOffer} from './billing-fixture-data';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/ui/account.css';

if(location.port!=='5192')throw Error('Use isolated port 5192.');
window.fetch=async()=>{throw Error('No network allowed in billing fixture');};
const scenario=new URLSearchParams(location.search).get('scenario');
const monthly:BillingOffer={...billingOffer,channels:billingOffer.channels.filter(c=>c.provider==='creem')};
const annual:BillingOffer={...monthly,id:'fixture-annual',interval:'year',unit_amount:5999};
const pack:BillingOffer={...monthly,id:'fixture-pack',plan_id:'pages',name:'Lite 100 页',interval:'once',quota_pages:100,quota_validity_days:null,service_plan_id:'lite',trial_days:0};
const {channels:_channels,...subscriptionPrice}=annual;
const status:BillingStatus={enabled:scenario!=='disabled',provider:scenario==='managed'?'creem':null,
  providers:[{id:'stripe',label:'Stripe',environment:'test'},{id:'creem',label:'Creem',environment:'test'}],environment:'test',
  trial_eligible:scenario!=='managed',offers:scenario==='disabled'?[]:[monthly,annual],gift:null,entitlement_expires_at:null,
  subscription_checkout:scenario==='pending'?{id:'fixture-subscription',provider:'creem',price:annual,idempotency_key:null,error:null}:null,
  subscription:scenario==='managed'?{provider:'creem',price:subscriptionPrice,status:'active',next_billed_at:null,cancel_at:null,trial_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null,paid_ends_at:'2099-01-01T00:00:00Z'}:null};
if(scenario==='expired'||scenario==='revoked'){
  status.subscription={provider:'creem',price:subscriptionPrice,status:scenario==='expired'?'expired':'canceled',next_billed_at:null,cancel_at:null,trial_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null,paid_ends_at:'2099-01-01T00:00:00Z'};
  status.provider='creem';status.trial_eligible=false;
}
function report(value:string){document.getElementById('handoff')!.textContent=value;}
if(scenario?.startsWith('quota')){
  status.quota_offers=[pack,{...pack,id:'fixture-pack-expiring',name:'Lite 50 页',quota_pages:50,quota_validity_days:30}];
  if(scenario==='quota-member')status.subscription={provider:'creem',price:subscriptionPrice,status:'active',next_billed_at:null,cancel_at:null,trial_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null,paid_ends_at:'2099-01-01T00:00:00Z'};
}
if(scenario?.startsWith('gift-')){
  const state=scenario==='gift-pending'?'pending':scenario==='gift-scheduled'?'scheduled':'active';
  const start=new Date(Date.now()+(state==='active'?-2:12)*86400000).toISOString(),end=new Date(Date.parse(start)+30*86400000).toISOString();
  status.gift={days:30,state,starts_at:state==='pending'?null:start,ends_at:state==='pending'?null:end};
  status.trial_eligible=false;
  if(scenario!=='gift-only')status.subscription={provider:'creem',price:subscriptionPrice,status:state==='active'?'paused':'active',next_billed_at:start,cancel_at:null,trial_ends_at:null,paid_ends_at:start,auto_renew:true,can_cancel:true,renewal_state:state==='pending'?'deferring':'deferred',resume_at:status.gift.ends_at};
  if(scenario==='gift-canceling'&&status.subscription)Object.assign(status.subscription,{renewal_state:'canceling',auto_renew:false,can_cancel:false});
  if(scenario==='gift-attention'&&status.subscription)status.subscription.renewal_state='attention';
  if(scenario==='gift-resuming'&&status.subscription)status.subscription.renewal_state='resuming';
}
status.provider=status.subscription?.provider??null;
window.open=(()=>({opener:null,close:()=>{},location:{replace:(url:string)=>report(`已打开 ${new URL(url).hostname}${new URL(url).pathname}`)}})) as unknown as typeof window.open;
const api={
  base:'https://billing-fixture.invalid',
  billingStatus:async()=>structuredClone(status),
  syncBilling:async()=>({billing:structuredClone(status)}),
  cancelRenewal:async(provider:BillingProvider)=>{
    if(!status.subscription?.can_cancel||status.subscription.provider!==provider)throw Error('Duplicate cancellation or wrong provider');
    status.subscription={...status.subscription,auto_renew:false,can_cancel:false,renewal_state:'canceled',resume_at:null,next_billed_at:null};
    if(scenario==='gift-cancel-lost')throw Error('Cancellation accepted but response lost');
    report('已取消自动续费');return {...status};
  },
  billingPortal:async(provider:BillingProvider)=>{
    if(provider!==status.subscription?.provider)throw Error('Wrong portal provider');
    return {provider,url:'https://creem.io/my-orders/login/fixture'};
  },
} as unknown as Api;
function Fixture(){
  const loggedIn=scenario!=='guest';
  return <main style={{maxWidth:520,margin:'24px auto',padding:20}} onClickCapture={event=>{
    const link=(event.target as Element).closest('a');
    if(link?.href.includes('/pricing/')){event.preventDefault();report(`前往 ${link.href}`);}
  }}><h1>定价导航与订阅管理隔离验收</h1><p>模拟 API 与新标签页，不创建支付。</p><p id="handoff" role="status">尚未打开定价页面</p><MembershipCard api={api} loggedIn={loggedIn} onEntitlements={()=>{}} notify={()=>{}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
