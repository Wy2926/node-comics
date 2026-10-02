/** No payment requests or real account access; records the exact handoff selected by the UI. */
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
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
const {channels:_channels,...subscriptionPrice}=annual;
const status:BillingStatus={enabled:scenario!=='disabled',provider:scenario==='pending'||scenario==='managed'?'creem':null,
  providers:[{id:'stripe',label:'Stripe',environment:'test'},{id:'creem',label:'Creem',environment:'test'}],environment:'test',
  trial_eligible:scenario!=='managed',offers:scenario==='disabled'?[]:[monthly,annual],gift:null,entitlement_expires_at:null,checkout_pending:scenario==='pending',
  checkout_provider:scenario==='pending'?'creem':null,checkout_price:scenario==='pending'?annual:null,
  subscription:scenario==='managed'?{provider:'creem',price:subscriptionPrice,status:'active',next_billed_at:null,cancel_at:null,trial_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null,paid_ends_at:'2099-01-01T00:00:00Z'}:null};
if(scenario==='expired'||scenario==='revoked'){
  status.subscription={provider:'creem',price:subscriptionPrice,status:scenario==='expired'?'expired':'canceled',next_billed_at:null,cancel_at:null,trial_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null,paid_ends_at:'2099-01-01T00:00:00Z'};
  status.provider='creem';status.trial_eligible=false;
}
function report(value:string){document.getElementById('handoff')!.textContent=value;}
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
window.open=(()=>({opener:null,close:()=>{},location:{replace:(url:string)=>report(`已打开 ${new URL(url).hostname}${new URL(url).pathname}`)}})) as unknown as typeof window.open;
const api={
  billingCatalog:async()=>{if(scenario==='catalog-error')throw Error('Catalog unavailable');return {enabled:true,offers:status.offers};},
  billingStatus:async()=>structuredClone(status),
  syncBilling:async()=>({billing:structuredClone(status)}),
  cancelRenewal:async(provider:BillingProvider)=>{
    if(!status.subscription?.can_cancel||status.subscription.provider!==provider)throw Error('Duplicate cancellation or wrong provider');
    status.subscription={...status.subscription,auto_renew:false,can_cancel:false,renewal_state:'canceled',resume_at:null,next_billed_at:null};
    if(scenario==='gift-cancel-lost')throw Error('Cancellation accepted but response lost');
    report('已取消自动续费');return {...status};
  },
  startCheckout:async(priceId:string,provider:BillingProvider)=>{
    const price=status.offers.find(p=>p.id===priceId);
    if(!price?.channels.some(c=>c.provider===provider))throw Error('Unavailable provider');
    if(scenario==='pending'&&(priceId!==annual.id||provider!=='creem'))throw Error('Pending channel changed');
    return {provider,trial:true,environment:'test',checkout_url:provider==='creem'?`https://www.creem.io/test/checkout/${priceId}`:`https://checkout.stripe.com/c/pay/${priceId}`};
  },
  billingPortal:async(provider:BillingProvider)=>{
    if(provider!==status.subscription?.provider)throw Error('Wrong portal provider');
    return {provider,url:'https://creem.io/my-orders/login/fixture'};
  },
} as unknown as Api;
function Fixture(){
  const [loggedIn,setLoggedIn]=useState(!['guest','catalog-error'].includes(scenario??''));
  return <main style={{maxWidth:520,margin:'24px auto',padding:20}}><h1>多渠道结账隔离验收</h1><p>模拟 API 与新标签页，不创建支付。</p><p id="handoff" role="status">尚未发起结账</p><MembershipCard api={api} loggedIn={loggedIn} onLogin={()=>setLoggedIn(true)} onEntitlements={()=>{}} notify={()=>{}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
