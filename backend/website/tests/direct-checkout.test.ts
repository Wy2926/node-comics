import { test } from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isValidElement,type ReactElement,type ReactNode} from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import * as intent from '../src/lib/checkout-intent';
import {checkoutStatusCopy} from '../src/i18n/commerce';
import {dictionaries} from '../src/i18n';
import type {CheckoutCopy} from '../src/components/CheckoutButton';
import { checkoutSelection, directCheckout } from '../src/lib/direct-checkout';
import { rememberCheckout, takeCheckout, checkoutIntentKey,PurchaseRetryAllowed,purchaseIntent,readPurchaseIntent } from '../src/lib/checkout-intent';
import { accountReturnPath } from '../src/lib/auth-config';
import {ApiError,type api} from '../src/lib/auth';
import { locales, localPath } from '../src/i18n/locales';
import type { Billing, BillingOffer, PendingCheckout, BillingProvider } from '../src/lib/billing';
import { publishedSubscriptions } from '../src/data/published-plans';
const month: BillingOffer = { id:'lite-month',name:'Lite',plan_id:'lite',plan_revision_id:'v1',currency:'usd',unit_amount:599,interval:'month',monthly_classic_pages:0,trial_days:7,trial_classic_pages:0,channels:[{provider:'creem',binding_id:'binding',trial_days:7,trial_classic_pages:0}] };
const year: BillingOffer = {...month,id:'lite-year',unit_amount:5999,interval:'year'};
const pack:BillingOffer={...month,id:'pack',plan_id:'pages',interval:'once',quota_pages:100,quota_validity_days:null,service_plan_id:'lite',trial_days:0};
const billing: Billing = {enabled:true,providers:[],provider:null,environment:'test',trial_eligible:true,subscription_checkout:null,offers:[month,year],entitlement_expires_at:null,gift:null,subscription:null};
const pendingCheckout=(price:BillingOffer,provider:BillingProvider='creem',key:string|null=null):PendingCheckout=>({id:'checkout-'+price.id,provider,price,idempotency_key:key,error:null});
function memoryStorage(){
  const values=new Map<string,string>();
  return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)} as unknown as Storage;
}

test('direct checkout uses exact quote and pending channel, never another interval', () => {
  assert.deepEqual(checkoutSelection(billing,'lite-year'),{price_id:'lite-year',provider:'creem'});
  assert.throws(()=>checkoutSelection({...billing,offers:[month]},'lite-year'));
  assert.throws(()=>checkoutSelection({...billing,enabled:false},'lite-year'));
  const original=pendingCheckout({...year,channels:[{...year.channels[0],provider:'stripe'}]},'stripe');
  const pending = {...billing,subscription_checkout:original,offers:[month]};
  assert.deepEqual(checkoutSelection(pending,'lite-year'),{price_id:'lite-year',provider:'stripe'});
  assert.deepEqual(checkoutSelection(pending,'lite-month'),{price_id:'lite-month',provider:'creem'});
  assert.throws(()=>checkoutSelection({...pending,subscription_checkout:{...original,provider:'creem'}},'lite-year'));
  assert.throws(()=>checkoutSelection(pending,'unavailable-price'));
  assert.equal(checkoutSelection({...billing,gift:{state:'active',starts_at:null,ends_at:null,days:30}},'lite-year'),null);
  assert.equal(checkoutSelection({...billing,subscription:{status:'active'} as Billing['subscription']},'lite-year'),null);
});

test('checkout sends one POST, validates destination/provider, and never retries uncertain writes', async () => {
  for (const scenario of ['ok','network','host','provider'] as const) {
    const calls: string[] = [];
    const request = (async (path: string, method?: string, body?: unknown) => {
      calls.push(path);
      if (path.startsWith('/v1/billing/status')) return billing;
      assert.equal(method,'POST');
      assert.deepEqual(body,{price_id:'lite-year',provider:'creem'});
      if (scenario === 'network') throw new TypeError('Network failure');
      return {provider:scenario === 'provider'?'stripe':'creem',checkout_url:scenario === 'host'?'https://evil.example/':'https://creem.io/test/checkout/fixture'};
    }) as typeof api;
    if (scenario === 'ok') assert.equal(await directCheckout('lite-year',request),'https://creem.io/test/checkout/fixture');
    else await assert.rejects(directCheckout('lite-year',request));
    assert.deepEqual(calls.map(path=>path.split('?')[0]),['/v1/billing/status','/v1/billing/checkouts']);
  }
});

for (const published of publishedSubscriptions) {
  const offer: BillingOffer = {
    ...published,
    id: `fixture-${published.plan_id}-${published.interval}`,
    channels: [{provider:'creem',binding_id:'fixture-binding',trial_days:0,trial_classic_pages:0}],
  };

  test(`${offer.plan_id} ${offer.interval} checkout follows the active quote, including after an expired gift`, async () => {
    for (const gift of [null, {state:'expired' as const,starts_at:null,ends_at:null,days:6}]) {
      const status: Billing = {...billing,offers:[offer],gift};
      const calls: string[] = [];
      const request = (async (path: string, method?: string, body?: unknown) => {
        calls.push(path);
        if (path.startsWith('/v1/billing/status')) {
          assert.equal(method,'GET');
          return status;
        }
        assert.equal(path,'/v1/billing/checkouts');
        assert.equal(method,'POST');
        assert.deepEqual(body,{price_id:offer.id,provider:'creem'});
        return {provider:'creem',checkout_url:'https://creem.io/checkout/fixture'};
      }) as typeof api;
      assert.equal(await directCheckout(offer.id,request),'https://creem.io/checkout/fixture');
      assert.deepEqual(calls.map(path=>path.split('?')[0]),['/v1/billing/status','/v1/billing/checkouts']);
    }
  });

  test(`${offer.plan_id} ${offer.interval} never bypasses quote, channel or existing membership checks`, () => {
    const status: Billing = {...billing,offers:[offer]};
    assert.throws(()=>checkoutSelection({...status,enabled:false},offer.id),/CHECKOUT_UNAVAILABLE/);
    assert.throws(()=>checkoutSelection({...status,offers:[]},offer.id),/CHECKOUT_UNAVAILABLE/);
    assert.throws(()=>checkoutSelection({...status,offers:[{...offer,channels:[]}]},offer.id),/CHECKOUT_UNAVAILABLE/);
    assert.throws(()=>checkoutSelection({...status,offers:[published]},published.id),/CHECKOUT_UNAVAILABLE/);
    for (const state of ['pending','scheduled','active'] as const) {
      assert.equal(checkoutSelection({...status,gift:{state,starts_at:null,ends_at:null,days:30}},offer.id),null);
    }
    assert.equal(checkoutSelection({...status,subscription:{status:'active'} as Billing['subscription']},offer.id),null);
    const original = pendingCheckout({...offer,id:'retired-price',channels:[{...offer.channels[0],provider:'stripe'}]},'stripe');
    const pending = {...status,subscription_checkout:original};
    assert.deepEqual(checkoutSelection(pending,offer.id),{price_id:offer.id,provider:'creem'});
    assert.deepEqual(checkoutSelection(pending,original.price.id),{price_id:original.price.id,provider:'stripe'});
  });
}

test('all page packs remain available to members, gifts and pending subscriptions',()=>{
  for(const extra of [{},{subscription:{status:'active'} as Billing['subscription']},{gift:{state:'active' as const,starts_at:null,ends_at:null,days:30}},{subscription_checkout:pendingCheckout(year)}]){
    assert.deepEqual(checkoutSelection({...billing,...extra,quota_offers:[pack]},pack.id),{price_id:pack.id,provider:'creem'});
  }
});

test('a different subscription quote creates its own checkout instead of redirecting to the old price',async()=>{
  const calls:string[]=[];
  const request=(async(path:string,method?:string,body?:unknown)=>{
    calls.push(path);
    if(method==='GET')return {...billing,subscription_checkout:pendingCheckout(year)};
    assert.deepEqual(body,{price_id:month.id,provider:'creem'});
    return {provider:'creem',checkout_url:'https://creem.io/test/checkout/new-month'};
  }) as typeof api;
  assert.equal(await directCheckout(month.id,request),'https://creem.io/test/checkout/new-month');
  assert.deepEqual(calls,['/v1/billing/status?price_id=lite-month','/v1/billing/checkouts']);
});

test('an unpaid subscription does not block new quota orders and quota intents do not block subscribing',async()=>{
  const storage=memoryStorage(),writes:{body:unknown;headers?:Record<string,string>}[]=[];
  purchaseIntent(storage,'buyer',pack.id,'creem');
  let pending=true;
  const request=(async(path:string,_method?:string,body?:unknown,headers?:Record<string,string>)=>{
    if(path.startsWith('/v1/billing/status'))return {...billing,quota_offers:[pack],subscription_checkout:pending?pendingCheckout(year):null};
    if(path==='/v1/me')return {user:{id:'buyer'}};
    writes.push({body,headers});return {provider:'creem',checkout_url:'https://creem.io/test/checkout/new-kind'};
  }) as typeof api;
  assert.equal(await directCheckout(pack.id,request,storage),'https://creem.io/test/checkout/new-kind');
  pending=false;
  assert.equal(await directCheckout(month.id,request,storage),'https://creem.io/test/checkout/new-kind');
  assert.deepEqual(writes.map(write=>write.body),[{price_id:pack.id,provider:'creem'},{price_id:month.id,provider:'creem'}]);
  assert.ok(writes[0].headers?.['Idempotency-Key']);assert.equal(writes[1].headers,undefined);
});

test('a retired subscription quote and an unconfirmed retired quota retain their original providers and keys',async()=>{
  const subscription=pendingCheckout({...year,id:'retired-subscription',channels:[{...year.channels[0],provider:'stripe'}]},'stripe');
  const storage=memoryStorage(),writes:{body:unknown;headers?:Record<string,string>}[]=[];
  const quota=purchaseIntent(storage,'buyer','retired-pack','creem');
  purchaseIntent(storage,'buyer','different-pack','stripe');
  const request=(async(path:string,_method?:string,body?:unknown,headers?:Record<string,string>)=>{
    if(path.startsWith('/v1/billing/status'))return {...billing,offers:[],quota_offers:[],subscription_checkout:subscription};
    if(path==='/v1/me')return {user:{id:'buyer'}};
    writes.push({body,headers});const provider=(body as {provider:BillingProvider}).provider;
    return {provider,checkout_url:provider==='stripe'?'https://checkout.stripe.com/c/pay/original':'https://creem.io/test/checkout/original'};
  }) as typeof api;
  assert.equal(await directCheckout(subscription.price.id,request,storage),'https://checkout.stripe.com/c/pay/original');
  assert.equal(await directCheckout('retired-pack',request,storage),'https://creem.io/test/checkout/original');
  assert.deepEqual(writes,[
    {body:{price_id:subscription.price.id,provider:'stripe'},headers:undefined},
    {body:{price_id:'retired-pack',provider:'creem'},headers:{'Idempotency-Key':quota.key}},
  ]);
  assert.equal(readPurchaseIntent(storage,'buyer','retired-pack'),null);
  assert.ok(readPurchaseIntent(storage,'buyer','different-pack'));
});

test('an unavailable quote without this account\'s local original request never creates a purchase',async()=>{
  const storage=memoryStorage();purchaseIntent(storage,'another-buyer','retired-pack','creem');
  const calls:string[]=[];
  const request=(async(path:string)=>{calls.push(path);return path==='/v1/me'?{user:{id:'buyer'}}:billing;}) as typeof api;
  await assert.rejects(directCheckout('retired-pack',request,storage),/CHECKOUT_UNAVAILABLE/);
  assert.deepEqual(calls,['/v1/billing/status?price_id=retired-pack','/v1/me']);
});

test('unconfirmed purchase keys are account-and-quote scoped, retain their provider and never clear a newer intent',()=>{
  const storage=memoryStorage();
  const first=purchaseIntent(storage,'user-a',pack.id,'creem');
  assert.equal(purchaseIntent(storage,'user-a',pack.id,'creem').key,first.key);
  assert.notEqual(purchaseIntent(storage,'user-b',pack.id,'creem').key,first.key);
  const other=purchaseIntent(storage,'user-a','other-pack','stripe');
  assert.notEqual(other.key,first.key);
  const resumed=purchaseIntent(storage,'user-a',pack.id,'stripe');
  assert.equal(resumed.key,first.key);assert.equal(resumed.provider,'creem');
  first.complete();
  const next=purchaseIntent(storage,'user-a',pack.id,'stripe');assert.notEqual(next.key,first.key);
  resumed.complete();
  assert.equal(readPurchaseIntent(storage,'user-a',pack.id)?.key,next.key);
  assert.equal(readPurchaseIntent(storage,'user-a','other-pack')?.key,other.key);
});

test('one-time checkout retains its key after response loss and clears on confirmed fulfillment',async()=>{
  const storage=memoryStorage();
  const keys:string[]=[];
  let fulfilled=false;
  const request=(async(path:string,method?:string,body?:unknown,headers?:Record<string,string>)=>{
    if(path.startsWith('/v1/billing/status'))return {...billing,quota_offers:[pack]};
    if(path==='/v1/me')return {user:{id:'verified-user'}};
    assert.equal(method,'POST');assert.deepEqual(body,{price_id:'pack',provider:'creem'});
    assert.ok(headers?.['Idempotency-Key']);keys.push(headers['Idempotency-Key']);
    if(!fulfilled)throw new TypeError('Response lost');
    return {provider:'creem',fulfilled:true,checkout_url:null};
  }) as typeof api;
  await assert.rejects(directCheckout(pack.id,request,storage));
  await assert.rejects(directCheckout(pack.id,request,storage));
  assert.equal(keys[0],keys[1]);assert.equal(keys.length,2);
  fulfilled=true;
  assert.deepEqual(await directCheckout(pack.id,request,storage),{fulfilled:true});
  assert.equal(keys[0],keys[2]);
  await directCheckout(pack.id,request,storage);
  assert.notEqual(keys[0],keys[3]);
});

test('A to B to A response-loss retries remain independent and keep each original provider despite catalog changes',async()=>{
  const storage=memoryStorage(),other={...pack,id:'other-pack'},writes:{price_id:string;provider:string;key:string}[]=[];
  let changed=false;
  const request=(async(path:string,_method?:string,body?:{price_id:string;provider:string},headers?:Record<string,string>)=>{
    if(path.startsWith('/v1/billing/status'))return {...billing,quota_offers:changed?[{...pack,channels:[{...pack.channels[0],provider:'stripe'}]},other]:[pack,other]};
    if(path==='/v1/me')return {user:{id:'buyer'}};
    writes.push({...body!,key:headers!['Idempotency-Key']});throw new TypeError('Response lost');
  }) as typeof api;
  await assert.rejects(directCheckout(pack.id,request,storage));
  changed=true;await assert.rejects(directCheckout(other.id,request,storage));
  await assert.rejects(directCheckout(pack.id,request,storage));
  assert.equal(writes[0].key,writes[2].key);assert.notEqual(writes[0].key,writes[1].key);
  assert.deepEqual(writes.map(write=>write.provider),['creem','creem','creem']);
});

test('a validated quota checkout URL ends only its request, so explicit same-price and different-price purchases get new keys',async()=>{
  const storage=memoryStorage(),other={...pack,id:'other-pack'},writes:{price_id:string;key:string}[]=[];
  const request=(async(path:string,_method?:string,body?:{price_id:string},headers?:Record<string,string>)=>{
    if(path.startsWith('/v1/billing/status'))return {...billing,quota_offers:[pack,other]};
    if(path==='/v1/me')return {user:{id:'buyer'}};
    writes.push({price_id:body!.price_id,key:headers!['Idempotency-Key']});
    return {provider:'creem',checkout_url:'https://creem.io/test/checkout/independent'};
  }) as typeof api;
  for(const quote of [pack,other,pack]){
    await directCheckout(quote.id,request,storage);assert.equal(readPurchaseIntent(storage,'buyer',quote.id),null);
  }
  assert.equal(new Set(writes.map(write=>write.key)).size,3);
  assert.deepEqual(writes.map(write=>write.price_id),[pack.id,other.id,pack.id]);
});

test('wrong-provider, missing and unsafe URLs never clear the original quota intent',async()=>{
  const storage=memoryStorage(),keys:string[]=[];
  let result:{provider:string;checkout_url:string|null}={provider:'stripe',checkout_url:'https://creem.io/test/checkout/wrong-provider'};
  const request=(async(path:string,_method?:string,_body?:unknown,headers?:Record<string,string>)=>{
    if(path.startsWith('/v1/billing/status'))return {...billing,quota_offers:[pack]};
    if(path==='/v1/me')return {user:{id:'buyer'}};
    keys.push(headers!['Idempotency-Key']);return result;
  }) as typeof api;
  for(const response of [result,{provider:'creem',checkout_url:null},{provider:'creem',checkout_url:'https://evil.example/checkout'}]){
    result=response;await assert.rejects(directCheckout(pack.id,request,storage));
    assert.equal(readPurchaseIntent(storage,'buyer',pack.id)?.key,keys[0]);
  }
  result={provider:'creem',checkout_url:'https://creem.io/test/checkout/verified'};
  await directCheckout(pack.id,request,storage);assert.equal(new Set(keys).size,1);
  assert.equal(readPurchaseIntent(storage,'buyer',pack.id),null);
});

test('a verified unpaid terminal response offers, but never automatically starts, a new purchase',async()=>{
  const storage=memoryStorage();
  const keys:string[]=[];
  let code='BILLING_PURCHASE_RETRY_ALLOWED',status=409;
  const request=(async(path:string,_method?:string,_body?:unknown,headers?:Record<string,string>)=>{
    if(path.startsWith('/v1/billing/status'))return {...billing,quota_offers:[pack]};
    if(path==='/v1/me')return {user:{id:'verified-user'}};
    keys.push(headers!['Idempotency-Key']);throw new ApiError('checkout ended',status,code);
  }) as typeof api;
  let retry:PurchaseRetryAllowed|undefined;
  await assert.rejects(directCheckout(pack.id,request,storage),error=>{assert.ok(error instanceof PurchaseRetryAllowed);retry=error;return true;});
  assert.equal(keys.length,1);
  await assert.rejects(directCheckout(pack.id,request,storage),PurchaseRetryAllowed);
  assert.equal(keys[0],keys[1]);
  retry!.restart(); // Represents the explicit “Start a new purchase” click.
  await assert.rejects(directCheckout(pack.id,request,storage),PurchaseRetryAllowed);
  assert.notEqual(keys[0],keys[2]);
  for(const input of [{code:'BILLING_PURCHASE_REVOKED',status:409},{code:'BILLING_PURCHASE_RETRY_ALLOWED',status:503}]){
    ({code,status}=input);
    await assert.rejects(directCheckout(pack.id,request,storage),error=>{assert.ok(error instanceof ApiError);return true;});
    assert.equal(keys.at(-1),keys[2]);
  }
});

test('login checkout intent is exact, expires, and can only be consumed once', () => {
  const storage=memoryStorage();
  for (const locale of locales) {
    const path = localPath('/pricing/?price=lite-year',locale);
    assert.equal(accountReturnPath(path),path);
    rememberCheckout(storage,path,'lite-year',100);
    assert.equal(takeCheckout(storage,path,200),'lite-year');
    assert.equal(takeCheckout(storage,path,201),undefined);
    rememberCheckout(storage,path,'lite-year',100);
    assert.equal(takeCheckout(storage,path,100+15*60*1000),undefined);
    rememberCheckout(storage,path,'lite-year',100);
    assert.equal(takeCheckout(storage,path.replace('lite-year','lite-month'),200),undefined);
  }
  for (const path of ['//evil.example/pricing/?price=x','/pricing/?price=x&next=evil','/pricing/?price=../x','/pricing/?price='+ 'x'.repeat(37)]) {
    assert.equal(accountReturnPath(path),'/account/');
    assert.throws(()=>rememberCheckout(storage,path,'x'));
  }
  storage.setItem(checkoutIntentKey,'bad-json');
  assert.equal(takeCheckout(storage,'/pricing/?price=lite-year'),undefined);
});

type Props={children?:ReactNode;role?:string;'data-purchase-link'?:boolean;'aria-disabled'?:boolean;onClick?:(event:unknown)=>void};
function nodes(value:ReactNode):ReactElement<Props>[]{
  return Array.isArray(value)?value.flatMap(nodes):isValidElement<Props>(value)?[value,...nodes(value.props.children)]:[];
}
function text(value:ReactNode):string{
  return Array.isArray(value)?value.map(text).join(''):isValidElement<Props>(value)?text(value.props.children):typeof value==='string'?value:'';
}
const source=readFileSync(new URL('../src/components/CheckoutButton.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const base:CheckoutCopy={busy:'busy',error:'safe fallback',before:'before',refund:'refund',renewal:'renewal',retry:'new purchase',retryHint:'verified unpaid'};

// Run the real button's catch/interaction path without a browser or live payment.
function button(copy:CheckoutCopy,checkout:()=>Promise<unknown>,signedIn=true,options:{search?:string;loginIntent?:boolean;continueAfterLogin?:boolean;session?:()=>Promise<unknown>}={}){
  const values:unknown[]=[],effects:(()=>unknown)[]=[],requests:string[]=[],redirects:string[]=[],logins:string[]=[];
  const storageValues=new Map<string,string>();
  const storage={getItem:(key:string)=>storageValues.get(key)??null,setItem:(key:string,value:string)=>storageValues.set(key,value),removeItem:(key:string)=>storageValues.delete(key)};
  let cursor=0,dirty=true,tree:ReactNode;
  const state=<T,>(initial:T)=>{const index=cursor++;if(index===values.length)values.push(initial);return [values[index],(next:unknown)=>{values[index]=typeof next==='function'?next(values[index]):next;dirty=true;}];};
  const modules:Record<string,unknown>={
    react:{useState:state,useRef:<T,>(initial:T)=>state({current:initial})[0],useEffect:(effect:()=>unknown)=>{const index=cursor++;if(index===values.length){values.push(true);effects.push(effect);}}},
    'react/jsx-runtime':jsx,'../lib/checkout-intent':intent,'../lib/auth-session':{ApiError},
    '../lib/direct-checkout':{session:options.session??(async()=>signedIn?{}:null),subscribeAuth:()=>()=>{},signIn:async(path:string)=>{logins.push(path);},
      directCheckout:async(price:string)=>{requests.push(price);return checkout();}},
  };
  const exported={} as typeof import('../src/components/CheckoutButton');
  const location={pathname:'/pricing/',search:options.search??'',assign:(url:string)=>redirects.push(url)},window=new EventTarget();
  if(options.loginIntent)intent.rememberCheckout(storage as unknown as Storage,location.pathname+location.search,'original-quote');
  new Function('require','exports','location','sessionStorage','window',compiled)((name:string)=>{assert.ok(name in modules,name);return modules[name];},exported,location,storage,window);
  const render=()=>{cursor=0;dirty=false;tree=exported.default({priceId:'original-quote',accountHref:'/account/',label:'purchase',copy,continueAfterLogin:options.continueAfterLogin});for(const effect of effects.splice(0))effect();};
  render();
  return {requests,redirects,logins,storage,
    returnFromCheckout:()=>window.dispatchEvent(Object.assign(new Event('pageshow'),{persisted:true})),
    flush:async()=>{for(let turn=0;turn<16;turn++){await Promise.resolve();if(dirty)render();}},
    click:()=>{const link=nodes(tree).find(node=>'data-purchase-link' in node.props);assert.ok(link?.props.onClick);link.props.onClick({preventDefault:()=>{}});},
    alert:()=>text(nodes(tree).find(node=>node.props.role==='alert')),
    label:()=>text(nodes(tree).find(node=>'data-purchase-link' in node.props)),
    busy:()=>nodes(tree).find(node=>'data-purchase-link' in node.props)?.props['aria-disabled'],
  };
}

test('all 17 languages provide distinct checkout verification and conflict guidance',()=>{
  for(const locale of locales){
    const copy=checkoutStatusCopy(locale);
    assert.deepEqual(Object.keys(copy).sort(),['conflict','uncertain']);
    assert.match(copy.uncertain,/comics@nodelane\.net/,locale);
    for(const value of Object.values(copy)){
      assert.ok(value.trim(),locale);assert.notEqual(value,dictionaries[locale].account?.['操作暂未完成，请重试或重新登录。'],locale);
      if(locale!=='en')assert.ok(!Object.values(checkoutStatusCopy('en')).includes(value),locale);
    }
    assert.notEqual(copy.uncertain,copy.conflict,locale);
  }
});

for(const [code,key] of [['CREEM_CHECKOUT_UNCERTAIN','uncertain'],['BILLING_CHECKOUT_UNCERTAIN','uncertain'],['BILLING_CHECKOUT_PRICE_CONFLICT','conflict']] as const){
  test(`${code} displays localized guidance by code without retrying or changing the quote`,async()=>{
    for(const locale of locales){
      const copy={...base,...checkoutStatusCopy(locale)};
      const view=button(copy,async()=>{throw new ApiError('untrusted provider detail',409,code);});
      view.click();await view.flush();
      assert.equal(view.alert(),copy[key],locale);assert.equal(view.busy(),undefined);
      assert.deepEqual(view.requests,['original-quote']);assert.deepEqual(view.redirects,[]);assert.deepEqual(view.logins,[]);
      await view.flush();assert.equal(view.requests.length,1,'no automatic retry');
      view.click();await view.flush();assert.deepEqual(view.requests,['original-quote','original-quote'],'only another explicit click retries the same quote');
    }
  });
}

test('network, authentication and unknown errors retain the safe fallback and never match message text',async()=>{
  for(const error of [new TypeError('network detail'),new ApiError('login detail',401,'LOGIN_REQUIRED'),
    new ApiError('CREEM_CHECKOUT_UNCERTAIN',409,'UNKNOWN_CODE'),new Error('BILLING_CHECKOUT_PRICE_CONFLICT'),
    {code:'CREEM_CHECKOUT_UNCERTAIN',message:'not an API error'}]){
    const view=button({...base,...checkoutStatusCopy('zh-CN')},async()=>{throw error;});
    view.click();await view.flush();assert.equal(view.alert(),base.error);assert.equal(view.requests.length,1);
    assert.deepEqual(view.redirects,[]);assert.equal(view.busy(),undefined);
  }
});

test('verified unpaid quota retry and signed-out login retain their existing explicit actions',async()=>{
  let restarted=0,attempts=0;
  const view=button({...base,...checkoutStatusCopy('en')},async()=>{
    if(attempts++===0)throw new intent.PurchaseRetryAllowed(()=>{restarted++;});
    return 'https://creem.io/test/checkout/verified';
  });
  view.click();await view.flush();assert.equal(view.alert(),base.retryHint);assert.equal(view.label(),base.retry);
  assert.equal(restarted,0);assert.equal(attempts,1);
  view.returnFromCheckout();await view.flush();assert.equal(restarted,0);assert.equal(view.label(),base.retry);
  view.click();await view.flush();assert.equal(restarted,1);assert.equal(attempts,2);
  assert.deepEqual(view.redirects,['https://creem.io/test/checkout/verified']);
  const signedOut=button({...base,...checkoutStatusCopy('en')},async()=>{throw Error('must not purchase before login');},false);
  signedOut.click();await signedOut.flush();assert.deepEqual(signedOut.requests,[]);
  assert.deepEqual(signedOut.logins,['/pricing/?price=original-quote']);assert.ok(signedOut.storage.getItem(intent.checkoutIntentKey));
});

test('pricing URLs never auto-purchase without a fresh login intent, and retired-quote recovery is always manual',async()=>{
  for(const options of [{search:'?price=original-quote'},{search:'?price=original-quote',loginIntent:true,continueAfterLogin:false}]){
    const view=button(base,async()=>'/checkout',true,options);await view.flush();
    assert.deepEqual(view.requests,[]);assert.equal(view.storage.getItem(intent.checkoutIntentKey),null);
    view.click();await view.flush();assert.deepEqual(view.requests,['original-quote']);
  }
  const login=button(base,async()=>'/checkout',true,{search:'?price=original-quote',loginIntent:true});await login.flush();
  assert.deepEqual(login.requests,['original-quote']);assert.equal(login.storage.getItem(intent.checkoutIntentKey),null);
  login.returnFromCheckout();await login.flush();assert.equal(login.requests.length,1);
});

test('one button blocks duplicate clicks, but returning from hosted checkout permits another explicit purchase',async()=>{
  const view=button(base,async()=>'/checkout');
  view.click();view.click();await view.flush();assert.deepEqual(view.requests,['original-quote']);assert.equal(view.busy(),true);
  view.returnFromCheckout();await view.flush();assert.equal(view.busy(),undefined);assert.equal(view.requests.length,1);
  view.click();await view.flush();assert.deepEqual(view.requests,['original-quote','original-quote']);
});

test('a bfcache return invalidates an old response without automatically starting or clearing a retry',async()=>{
  let finish!:(url:string)=>void;
  const view=button(base,()=>new Promise<string>(resolve=>{finish=resolve;}));
  view.click();await view.flush();assert.equal(view.requests.length,1);
  view.returnFromCheckout();await view.flush();finish('/late-checkout');await view.flush();
  assert.deepEqual(view.redirects,[]);assert.equal(view.busy(),undefined);assert.equal(view.requests.length,1);
});

test('returning during session preflight prevents the stale button action from starting a checkout',async()=>{
  let resolve!:(session:object)=>void;
  const session=new Promise<object>(done=>{resolve=done;});
  const view=button(base,async()=>'/checkout',true,{session:()=>session});
  view.click();await view.flush();assert.equal(view.requests.length,0);
  view.returnFromCheckout();resolve({});await view.flush();assert.equal(view.requests.length,0);
  view.click();await view.flush();assert.deepEqual(view.requests,['original-quote']);
});

test('pricing passes the same localized error copy to subscription and quota checkout buttons',()=>{
  const pricing=readFileSync(new URL('../src/components/BillingOffers.tsx',import.meta.url),'utf8');
  assert.match(pricing,/buttonCopy=\{\.\.\.checkoutCopy,\.\.\.checkoutStatusCopy\(locale\)\}/);
  assert.match(pricing,/<CheckoutButton[^>]*copy=\{buttonCopy\}/);
  assert.match(pricing,/<QuotaOffers[^>]*checkoutCopy=\{buttonCopy\}/);
});
