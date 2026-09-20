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
const annual:BillingOffer={...billingOffer,id:'fixture-annual',interval:'year',unit_amount:9999,channels:billingOffer.channels.filter(c=>c.provider==='creem')};
const {channels:_channels,...subscriptionPrice}=annual;
const status:BillingStatus={enabled:scenario!=='disabled',provider:scenario==='pending'||scenario==='managed'?'creem':null,
  providers:[{id:'stripe',label:'Stripe',environment:'test'},{id:'creem',label:'Creem',environment:'test'}],environment:'test',
  trial_eligible:scenario!=='managed',offers:scenario==='disabled'?[]:[billingOffer,annual],entitlement_expires_at:null,checkout_pending:scenario==='pending',
  checkout_provider:scenario==='pending'?'creem':null,checkout_price:scenario==='pending'?annual:null,
  subscription:scenario==='managed'?{provider:'creem',price:subscriptionPrice,status:'active',next_billed_at:null,cancel_at:null,trial_ends_at:null,paid_ends_at:'2099-01-01T00:00:00Z'}:null};
if(scenario==='expired'||scenario==='revoked'){
  status.subscription={provider:'creem',price:subscriptionPrice,status:scenario==='expired'?'expired':'canceled',next_billed_at:null,cancel_at:null,trial_ends_at:null,paid_ends_at:'2099-01-01T00:00:00Z'};
  status.provider='creem';status.trial_eligible=false;
}
function report(value:string){document.getElementById('handoff')!.textContent=value;}
window.open=(()=>({opener:null,close:()=>{},location:{replace:(url:string)=>report(`已打开 ${new URL(url).hostname}${new URL(url).pathname}`)}})) as unknown as typeof window.open;
const api={
  billingStatus:async()=>status,
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
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:520,margin:'24px auto',padding:20}}><h1>多渠道结账隔离验收</h1><p>模拟 API 与新标签页，不创建支付。</p><p id="handoff" role="status">尚未发起结账</p><MembershipCard api={api} loggedIn={true} onLogin={()=>{}} onEntitlements={()=>{}} notify={()=>{}}/></main>);
