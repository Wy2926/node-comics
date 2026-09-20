import {test} from 'node:test';
import assert from 'node:assert/strict';
import {amount,type BillingOffer} from '../src/lib/billing';
import {selectedInterval} from '../src/components/BillingCycle';

test('billing cycles use available quotes and preserve the chosen cadence',()=>{
  const month={interval:'month'} as BillingOffer,year={interval:'year'} as BillingOffer;
  assert.equal(selectedInterval([month,year],'year'),'year');
  assert.equal(selectedInterval([year],'month'),'year');
  assert.equal(selectedInterval([month],'year'),'month');
  assert.equal(selectedInterval([],'year'),'year');
});

test('Stripe minor units render correctly in public and account prices',()=>{
  const offer:BillingOffer={id:'test',name:'Sample',currency:'usd',unit_amount:999,interval:'year',monthly_redraw_pages:300,trial_days:0,trial_redraw_pages:0};
  for(const [currency,unit_amount,value] of [['usd',999,9.99],['jpy',500,500],['isk',500,5],['ugx',500,5]] as const)
    assert.equal(amount({...offer,currency,unit_amount},'en'),new Intl.NumberFormat('en',{style:'currency',currency}).format(value));
});
