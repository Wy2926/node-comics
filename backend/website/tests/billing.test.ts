import {test} from 'node:test';
import assert from 'node:assert/strict';
import {amount,selectedChannel,hasManagedSubscription,type BillingOffer} from '../src/lib/billing';
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
  const offer:BillingOffer={id:'test',name:'Sample',currency:'usd',unit_amount:999,interval:'year',monthly_redraw_pages:300,trial_days:0,trial_redraw_pages:0,channels:[{provider:'stripe',binding_id:'stripe-fixture',trial_days:7,trial_redraw_pages:30},{provider:'creem',binding_id:'creem-fixture',trial_days:7,trial_redraw_pages:30}]};
  for(const [currency,unit_amount,value] of [['usd',999,9.99],['jpy',500,500],['isk',500,5],['ugx',500,5]] as const)
    assert.equal(amount({...offer,currency,unit_amount},'en'),new Intl.NumberFormat('en',{style:'currency',currency}).format(value));
});
