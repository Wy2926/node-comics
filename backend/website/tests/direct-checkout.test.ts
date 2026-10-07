import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutSelection, directCheckout } from '../src/lib/direct-checkout';
import { rememberCheckout, takeCheckout, checkoutIntentKey } from '../src/lib/checkout-intent';
import { accountReturnPath } from '../src/lib/auth-config';
import type { api } from '../src/lib/auth';
import { locales, localPath } from '../src/i18n/locales';
import type { Billing, BillingOffer } from '../src/lib/billing';
const month: BillingOffer = { id:'lite-month',name:'Lite',plan_id:'lite',plan_revision_id:'v1',currency:'usd',unit_amount:599,interval:'month',monthly_redraw_pages:0,trial_days:7,trial_redraw_pages:0,channels:[{provider:'creem',binding_id:'binding',trial_days:7,trial_redraw_pages:0}] };
const year: BillingOffer = {...month,id:'lite-year',unit_amount:5999,interval:'year'};
const billing: Billing = {enabled:true,providers:[],provider:'creem',environment:'test',trial_eligible:true,checkout_pending:false,checkout_provider:null,checkout_price:null,offers:[month,year],entitlement_expires_at:null,gift:null,subscription:null};

test('direct checkout uses exact quote and pending channel, never another interval', () => {
  assert.deepEqual(checkoutSelection(billing,'lite-year'),{price_id:'lite-year',provider:'creem'});
  assert.throws(()=>checkoutSelection({...billing,offers:[month]},'lite-year'));
  assert.throws(()=>checkoutSelection({...billing,enabled:false},'lite-year'));
  const pending = {...billing,checkout_pending:true,checkout_provider:'stripe' as const,checkout_price:{...year,channels:[{...year.channels[0],provider:'stripe' as const}]},offers:[]};
  assert.deepEqual(checkoutSelection(pending,'lite-year'),{price_id:'lite-year',provider:'stripe'});
  assert.equal(checkoutSelection(pending,'lite-month'),null);
  assert.throws(()=>checkoutSelection({...pending,checkout_provider:'creem'},'lite-year'));
  assert.equal(checkoutSelection({...billing,gift:{state:'active',starts_at:null,ends_at:null,days:30}},'lite-year'),null);
  assert.equal(checkoutSelection({...billing,subscription:{status:'active'} as Billing['subscription']},'lite-year'),null);
});

test('checkout sends one POST, validates destination/provider, and never retries uncertain writes', async () => {
  for (const scenario of ['ok','network','host','provider'] as const) {
    const calls: string[] = [];
    const request = (async (path: string, method?: string, body?: unknown) => {
      calls.push(path);
      if (path === '/v1/billing/status') return billing;
      assert.equal(method,'POST');
      assert.deepEqual(body,{price_id:'lite-year',provider:'creem'});
      if (scenario === 'network') throw new TypeError('Network failure');
      return {provider:scenario === 'provider'?'stripe':'creem',checkout_url:scenario === 'host'?'https://evil.example/':'https://creem.io/test/checkout/fixture'};
    }) as typeof api;
    if (scenario === 'ok') assert.equal(await directCheckout('lite-year',request),'https://creem.io/test/checkout/fixture');
    else await assert.rejects(directCheckout('lite-year',request));
    assert.deepEqual(calls,['/v1/billing/status','/v1/billing/checkouts']);
  }
});

test('login checkout intent is exact, expires, and can only be consumed once', () => {
  const values = new Map<string,string>();
  const storage = {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)} as unknown as Storage;
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
