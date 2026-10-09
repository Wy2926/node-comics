import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {isValidElement,type ReactElement,type ReactNode} from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import {ApiError,type AuthIdentity} from '../src/lib/auth';
import * as authConfig from '../src/lib/auth-config';
import * as billingModule from '../src/lib/billing';
import * as quotaCopy from '../src/i18n/quota-purchase';

type Props={children?:ReactNode;className?:string;href?:string;disabled?:boolean;onClick?:()=>void;'aria-busy'?:boolean;role?:string};
type Element=ReactElement<Props>;
const compiled=ts.transpileModule(readFileSync(new URL('../src/components/Account.tsx',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const identity:AuthIdentity={id:'login-a',subject:'reader-a'};
const entitlement=(available=100)=>({plan:'lite',service_plan:'lite',plus_expires_at:null,
  purchase_quota:{granted:100,used:100-available,reserved:0,available,next_expiry_at:null}});
const account=(name='Reader A',available=100)=>({user:{id:name,name},entitlements:entitlement(available)});
const price:billingModule.BillingOffer={id:'month',name:'Lite',plan_id:'lite',plan_revision_id:'v1',currency:'usd',
  unit_amount:599,interval:'month',monthly_redraw_pages:0,trial_days:0,trial_redraw_pages:0,channels:[]};
const billing:billingModule.Billing={enabled:true,providers:[],provider:'creem',environment:'test',trial_eligible:false,
  subscription_checkout:null,offers:[],gift:null,entitlement_expires_at:null,
  subscription:{provider:'creem',status:'active',price,paid_ends_at:null,auto_renew:true,cancel_at:null,trial_ends_at:null,
    renewal_state:'normal',can_cancel:true,next_billed_at:null,resume_at:null}};
function deferred(){
  let resolve!:(value:unknown)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function elements(value:ReactNode):Element[]{
  if(Array.isArray(value))return value.flatMap(elements);
  return isValidElement<Props>(value)?[value,...elements(value.props.children)]:[];
}
function content(value:ReactNode):string{
  if(Array.isArray(value))return value.map(content).join('');
  return isValidElement<Props>(value)?content(value.props.children):typeof value==='string'||typeof value==='number'?String(value):'';
}

// Execute the actual component handlers with deterministic hook state and deferred
// API responses. Browser rendering/layout is separately covered by the account fixture.
function mount(){
  const cells:unknown[]=[],effects:(()=>void|(()=>void))[]=[],cleanups:(()=>void)[]=[];
  let cursor=0,dirty=true,tree:ReactNode,currentIdentity:AuthIdentity|null=identity,listener=()=>{};
  const calls:{path:string;method:string;identity:unknown;pending:ReturnType<typeof deferred>}[]=[];
  const state=<T,>(initial:T|(()=>T))=>{
    const index=cursor++;
    if(index===cells.length)cells.push(typeof initial==='function'?(initial as ()=>T)():initial);
    return [cells[index],(next:T|((previous:T)=>T))=>{cells[index]=typeof next==='function'?(next as (previous:T)=>T)(cells[index] as T):next;dirty=true;}] as const;
  };
  const modules:Record<string,unknown>={
    react:{useState:state,useRef:<T,>(value:T)=>state({current:value})[0],useEffect:(effect:()=>void|(()=>void))=>{const index=cursor++;if(index===cells.length){cells.push(true);effects.push(effect);}}},
    'react/jsx-runtime':jsx,'../lib/auth-config':authConfig,'../lib/billing':billingModule,'../i18n/quota-purchase':quotaCopy,
    '../lib/auth':{ApiError,sessionIdentity:async()=>currentIdentity,subscribeAuth:(next:()=>void)=>{listener=next;return()=>{listener=()=>{};};},
      signOut:async()=>{currentIdentity=null;listener();},api:(path:string,method='GET',_body?:unknown,_headers?:unknown,boundIdentity?:unknown)=>{
        const pending=deferred();calls.push({path,method,identity:boundIdentity,pending});return pending.promise;
      }},
  };
  const exported={} as typeof import('../src/components/Account');
  new Function('require','exports',compiled)((name:string)=>{assert.ok(name in modules,name);return modules[name];},exported);
  function render(){dirty=false;cursor=0;tree=exported.default({});for(const effect of effects.splice(0)){const cleanup=effect();if(cleanup)cleanups.push(cleanup);}}
  render();
  const all=()=>elements(tree),byClass=(name:string)=>all().find(node=>node.props.className?.split(' ').includes(name));
  const button=(label:string)=>{const value=all().find(node=>node.type==='button'&&content(node)===label);assert.ok(value,label);return value;};
  return {calls,all,byClass,button,text:()=>content(tree),
    flush:async()=>{for(let turn=0;turn<12;turn++){await Promise.resolve();if(dirty)render();}},
    response:(path:string,index=0)=>{const call=calls.filter(value=>value.path===path)[index];assert.ok(call,`${path} #${index}`);return call.pending;},
    change:(value:AuthIdentity|null)=>{currentIdentity=value;listener();},unmount:()=>cleanups.forEach(cleanup=>cleanup()),
  };
}
type View=ReturnType<typeof mount>;
async function ready(view:View){await view.flush();view.response('/v1/me').resolve(account());view.response('/v1/billing/status').resolve(billing);await view.flush();}
function click(node:Element){assert.ok(node.props.onClick);node.props.onClick();}

test('account and billing snapshots start in parallel; account appears without waiting for billing or provider sync',async()=>{
  const view=mount();await view.flush();
  assert.deepEqual(view.calls.map(({path,method,identity:bound})=>({path,method,bound})),[
    {path:'/v1/me',method:'GET',bound:identity},{path:'/v1/billing/status',method:'GET',bound:identity},
  ]);
  view.response('/v1/me').resolve(account());await view.flush();
  assert.ok(view.byClass('account-summary'));assert.equal(view.byClass('website-account')?.props['aria-busy'],false);
  assert.equal(view.byClass('account-subscription')?.props['aria-busy'],true);
  assert.equal(view.calls.filter(call=>call.method==='POST').length,0);
  view.response('/v1/billing/status').resolve(billing);await view.flush();
  assert.equal(view.byClass('account-subscription')?.props['aria-busy'],false);view.unmount();
});

test('failed initial billing is local, and its retry only reads billing status',async()=>{
  const view=mount();await view.flush();view.response('/v1/me').resolve(account());
  view.response('/v1/billing/status').reject(new TypeError('offline'));await view.flush();
  assert.ok(view.byClass('account-summary'));assert.ok(view.all().some(node=>node.props.role==='alert'));
  click(view.button('重试连接'));await view.flush();
  assert.deepEqual(view.calls.map(call=>call.path),['/v1/me','/v1/billing/status','/v1/billing/status']);
  assert.ok(view.calls.every(call=>call.method==='GET'));
  view.response('/v1/billing/status',1).resolve(billing);await view.flush();
  assert.equal(view.all().some(node=>node.props.role==='alert'),false);
});

test('account navigation stays on the plain pricing page with or without a pending subscription',async()=>{
  const original={id:'original-subscription',provider:'creem' as const,price,idempotency_key:null,error:null};
  for(const subscription_checkout of [null,original]){
    const view=mount();await view.flush();view.response('/v1/me').resolve(account());
    view.response('/v1/billing/status').resolve({...billing,subscription_checkout});await view.flush();
    const link=elements(view.byClass('account-purchase-link')).find(node=>node.type==='a');
    assert.equal(link?.props.href,'/pricing/');assert.ok(view.byClass('account-summary'));
  }
});

test('refresh keeps account visible, ignores repeated clicks, and locks billing actions but not logout',async()=>{
  const view=mount();await ready(view);
  click(view.button('取消自动续费'));await view.flush();
  const cancel=view.button('确认取消续费'),portal=view.all().find(node=>node.type==='button'&&content(node).includes('Creem'))!;
  const refresh=view.byClass('account-refresh')!;click(refresh);click(refresh);await view.flush();
  assert.equal(view.calls.filter(call=>call.path==='/v1/billing/sync').length,1);
  assert.ok(view.byClass('account-summary'));assert.equal(view.byClass('website-account')?.props['aria-busy'],false);
  assert.equal(view.byClass('account-refresh')?.props.disabled,true);
  assert.equal(view.button('退出登录').props.disabled,false);assert.equal(view.button('确认取消续费').props.disabled,true);
  click(cancel);click(portal);await view.flush(); // A stale same-frame callback is guarded by refs too.
  assert.equal(view.calls.filter(call=>call.method==='POST').length,1);
  view.response('/v1/billing/sync').resolve({billing,entitlements:entitlement(90)});await view.flush();
  assert.match(view.text(),/90/);assert.equal(view.byClass('account-refresh')?.props.disabled,false);
});

test('provider sync failure preserves balance and subscription; retry never repeats sync',async()=>{
  const view=mount();await ready(view);click(view.byClass('account-refresh')!);await view.flush();
  view.response('/v1/billing/sync').reject(new TypeError('provider timeout'));await view.flush();
  assert.ok(view.byClass('account-summary'));assert.match(view.text(),/100/);assert.ok(view.byClass('subscription-price'));
  click(view.button('重试连接'));await view.flush();
  assert.equal(view.calls.filter(call=>call.path==='/v1/billing/sync').length,1);
  view.response('/v1/billing/status',1).resolve(billing);await view.flush();
  assert.equal(view.byClass('account-subscription')?.props['aria-busy'],false);
});

test('failed replacement account clears prior data and rejects late billing; account retry remains available',async()=>{
  const view=mount();await ready(view);view.change({id:'login-b',subject:'reader-b'});await view.flush();
  assert.equal(view.byClass('account-summary'),undefined);assert.doesNotMatch(view.text(),/Reader A/);
  view.response('/v1/me',1).reject(new TypeError('offline'));await view.flush();
  view.response('/v1/billing/status',1).resolve(billing);await view.flush();
  assert.equal(view.byClass('account-summary'),undefined);assert.ok(view.byClass('login-passport'));
  click(view.button('重试连接'));await view.flush();view.response('/v1/me',2).resolve(account('Reader B'));
  view.response('/v1/billing/status',2).resolve(billing);await view.flush();assert.match(view.text(),/Reader B/);
});

for(const outcome of ['success','unauthorized'] as const)test(`switched session ignores old sync ${outcome} and preserves the new session's in-flight request`,async()=>{
  const view=mount();await ready(view);click(view.byClass('account-refresh')!);await view.flush();
  view.change({id:'login-b',subject:identity.subject});await view.flush(); // Same subject, different login is still isolated.
  view.response('/v1/me',1).resolve(account('Reader B',80));view.response('/v1/billing/status',1).resolve(billing);await view.flush();
  click(view.byClass('account-refresh')!);await view.flush();
  assert.equal(view.calls.filter(call=>call.path==='/v1/billing/sync').length,2);
  const old=view.response('/v1/billing/sync');
  if(outcome==='success')old.resolve({billing,entitlements:entitlement(1)});else old.reject(new ApiError('Expired',401));
  await view.flush();assert.match(view.text(),/Reader B/);assert.match(view.text(),/80/);assert.doesNotMatch(view.text(),/Expired/);
  assert.equal(view.byClass('account-subscription')?.props['aria-busy'],true);
  view.response('/v1/billing/sync',1).resolve({billing,entitlements:entitlement(70)});await view.flush();assert.match(view.text(),/70/);
});

test('logout during sync is immediate and its late unauthorized response cannot restore account or show an old error',async()=>{
  const view=mount();await ready(view);click(view.byClass('account-refresh')!);await view.flush();
  click(view.button('退出登录'));await view.flush();assert.ok(view.byClass('login-passport'));assert.equal(view.byClass('account-summary'),undefined);
  view.response('/v1/billing/sync').reject(new ApiError('Expired previous account',401));await view.flush();
  assert.ok(view.byClass('login-passport'));assert.doesNotMatch(view.text(),/Expired previous account|Reader A/);
});

test('a current background unauthorized response removes protected account data',async()=>{
  const view=mount();await ready(view);click(view.byClass('account-refresh')!);await view.flush();
  view.response('/v1/billing/sync').reject(new ApiError('Expired current account',401));await view.flush();
  assert.equal(view.byClass('account-summary'),undefined);assert.equal(view.byClass('account-subscription'),undefined);
  assert.ok(view.byClass('login-passport'));assert.match(view.text(),/Expired current account/);
});

test('late local status cannot restore renewal after cancellation, and loading still settles',async()=>{
  const view=mount();await ready(view);click(view.button('取消自动续费'));await view.flush();
  const cancel=view.button('确认取消续费');click(view.byClass('account-refresh')!);await view.flush();
  view.response('/v1/billing/sync').reject(new TypeError('offline'));await view.flush();
  click(view.button('重试连接'));click(cancel);await view.flush();
  view.response('/v1/billing/cancel-renewal').resolve({...billing,subscription:{...billing.subscription!,auto_renew:false,can_cancel:false}});await view.flush();
  view.response('/v1/billing/status',1).resolve(billing);await view.flush();
  assert.match(view.text(),/已关闭自动续费/);assert.equal(view.byClass('account-subscription')?.props['aria-busy'],false);
  assert.equal(view.byClass('website-account')?.props['aria-busy'],false);
});
