import {test} from 'node:test';
import assert from 'node:assert/strict';
import {annualSavings,amount,selectedChannel,hasManagedSubscription,type BillingOffer} from '../src/lib/billing';
import {selectedInterval} from '../src/components/BillingCycle';

test('billing cycles use available quotes and preserve the chosen cadence',()=>{
  const month={interval:'month'} as BillingOffer,year={interval:'year'} as BillingOffer;
  assert.equal(selectedInterval([month,year],'year'),'year');
  assert.equal(selectedInterval([year],'month'),'year');
  assert.equal(selectedInterval([month],'year'),'month');
  assert.equal(selectedInterval([],'year'),'year');
});

test('channel selection never changes a pending checkout provider',()=>{
  const offer={channels:[{provider:'stripe',binding_id:'stripe'},{provider:'creem',binding_id:'creem'}]} as BillingOffer;
  assert.equal(selectedChannel(offer,'creem')?.provider,'creem');
  assert.equal(selectedChannel(offer,'stripe','creem')?.provider,'creem');
  assert.equal(selectedChannel({...offer,channels:[offer.channels[0]]},'stripe','creem'),undefined);
  assert.equal(selectedChannel({...offer,channels:[]},'creem'),undefined);
  assert.equal(selectedChannel(offer,'')?.provider,'stripe');
});

test('expired and revoked terminal subscriptions allow another purchase',()=>{
  const now=Date.parse('2026-09-20T00:00:00Z');
  for(const status of ['active','trialing','paused','past_due','unpaid','incomplete','scheduled_cancel'])assert.equal(hasManagedSubscription(status,null,now),true);
  for(const status of ['canceled','expired','incomplete_expired']){
    assert.equal(hasManagedSubscription(status,null,now),false);
    assert.equal(hasManagedSubscription(status,'2026-09-19T00:00:00Z',now),false);
    assert.equal(hasManagedSubscription(status,'2026-09-21T00:00:00Z',now),true);
  }
  assert.equal(hasManagedSubscription(undefined,null,now),false);
});

test('Stripe minor units render correctly in public and account prices',()=>{
  const offer:BillingOffer={id:'test',name:'Sample',plan_id:'plus',plan_revision_id:'plus-v1',currency:'usd',unit_amount:999,interval:'year',monthly_redraw_pages:300,trial_days:0,trial_redraw_pages:0,channels:[{provider:'stripe',binding_id:'stripe-fixture',trial_days:7,trial_redraw_pages:30},{provider:'creem',binding_id:'creem-fixture',trial_days:7,trial_redraw_pages:30}]};
  for(const [currency,unit_amount,value] of [['usd',999,9.99],['jpy',500,500],['isk',500,5],['ugx',500,5]] as const)
    assert.equal(amount({...offer,currency,unit_amount},'en'),new Intl.NumberFormat('en',{style:'currency',currency}).format(value));
});

test('annual savings compare the same published benefits and currency',()=>{
  const month:BillingOffer={id:'month',plan_id:'plus',plan_revision_id:'plus-v1',name:'PLUS',currency:'usd',unit_amount:999,interval:'month',monthly_redraw_pages:300,trial_days:7,trial_redraw_pages:30,channels:[]};
  const year:BillingOffer={...month,id:'year',interval:'year',unit_amount:9999};
  assert.deepEqual(annualSavings(year,[month,year]),{regular:11988,saved:1989,percent:16.6});
  assert.equal(annualSavings(month,[month,year]),null);
  assert.equal(annualSavings(year,[year]),null);
  for(const mismatch of [{currency:'eur'},{plan_id:'other'},{plan_revision_id:'plus-v2'},{unit_amount:0}])
    assert.equal(annualSavings(year,[{...month,...mismatch},year]),null);
  for(const unit_amount of [11988,13000])assert.equal(annualSavings({...year,unit_amount},[month]),null);
  assert.deepEqual(annualSavings(year,[month,{...month,unit_amount:1099}]),annualSavings(year,[month]));
  assert.equal(amount({...year,unit_amount:year.unit_amount/12},'en'),'$8.33');
});
