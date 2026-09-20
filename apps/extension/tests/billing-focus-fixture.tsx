import {billingOffer} from './billing-fixture-data';
/** Synthetic API and tab handoff only. Does not use accounts, storage or external requests. */
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {MembershipCard} from '../src/ui/MembershipCard';
import type {Api} from '../src/api';
import type {BillingStatus} from '../src/billing';
import type {Entitlements} from '../src/types';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/ui/account.css';
if(location.port!=='5192')throw Error('Use isolated port 5192.');
window.fetch=async()=>{throw Error('No network allowed in billing fixture');};
const status:BillingStatus={offers:[billingOffer],checkout_price:null,enabled:true,providers:[{id:'stripe',label:'Stripe',environment:'test'},{id:'creem',label:'Creem',environment:'test'}],provider:'stripe',environment:'test',checkout_provider:null,trial_eligible:false,entitlement_expires_at:null,checkout_pending:false,subscription:{provider:'stripe',price:billingOffer,status:'active',next_billed_at:null,cancel_at:null,trial_ends_at:null,paid_ends_at:'2099-01-01T00:00:00Z'}};
const rights={plan:'plus',plus_expires_at:'2099-01-01T00:00:00Z'} as Entitlements;
const counts={reads:0,syncs:0,portals:0,opened:0};
let failPortal=false;
let releaseSync:()=>void=()=>{};
const fakeApi={
  billingStatus:async()=>{counts.reads++;return status;},
  syncBilling:async()=>{counts.syncs++;await new Promise<void>(resolve=>{releaseSync=resolve;});return {billing:status,entitlements:rights};},
  billingPortal:async()=>{counts.portals++;if(failPortal)throw Error('simulated portal failure');return {url:'https://billing.stripe.com/p/session/fixture',provider:'stripe'};},
} as unknown as Api;
window.open=(()=>({opener:null,close:()=>{},location:{replace:()=>{counts.opened++;}}})) as unknown as typeof window.open;
const flush=()=>new Promise(resolve=>setTimeout(resolve,50));
function Fixture(){
  const [report,setReport]=useState('尚未开始');
  const [running,setRunning]=useState(false);
  async function run(){
    setRunning(true);const checks:string[]=[];
    const button=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('.nc-membership-card button')].find(b=>b.textContent?.includes(name))!;
    const assert=(value:unknown,label:string)=>{if(!value)throw Error(label);checks.push(label);};
    const wake=()=>{for(let n=0;n<8;n++){window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));}};
    try{
      await flush();wake();await flush();
      assert(counts.reads===1&&counts.syncs===0,'重复焦点不触发 Stripe 对账');
      button('刷新权益').click();await flush();
      assert(counts.syncs===1&&!button('管理订阅').disabled,'缓慢刷新期间仍可管理订阅');
      const manage=button('管理订阅');manage.click();manage.click();await flush();
      assert(counts.portals===1&&counts.opened===1,'刷新期间打开成功，双击只创建一次');
      releaseSync();await flush();wake();await flush();
      assert(counts.syncs===2,'从 Stripe 返回只补充一次对账');
      wake();await flush();assert(counts.syncs===2,'对账期间重复焦点被合并');
      releaseSync();await flush();wake();await flush();
      assert(counts.syncs===2,'完成对账后焦点仍受冷却限制');
      failPortal=true;button('管理订阅').click();await flush();
      assert(!button('管理订阅').disabled&&!!document.querySelector('[role=alert]'),'打开失败后按钮可重试');
      failPortal=false;button('管理订阅').click();await flush();
      assert(counts.opened===2&&!document.querySelector('[role=alert]'),'重试成功并清除打开错误');
      setReport('PASS\n'+checks.join('\n')+'\n'+JSON.stringify(counts));
    }catch(error){setReport('FAIL '+String(error)+'\n'+checks.join('\n'));}
    finally{releaseSync();setRunning(false);}
  }
  return <main style={{maxWidth:600,margin:'24px auto',padding:16}}><h1>会员卡焦点与并发隔离验收</h1><button onClick={()=>void run()} disabled={running||report!=='尚未开始'}>运行回归检查</button><pre role="status" style={{whiteSpace:'pre-wrap'}}>{report}</pre><MembershipCard api={fakeApi} loggedIn rights={rights} onLogin={()=>{}} onEntitlements={()=>{}} notify={()=>{}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
