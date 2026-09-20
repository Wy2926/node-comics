import {describe,it,expect} from 'vitest';
import {stripeUrl,offerAmount} from '../src/billing';
import {billingOffer} from './billing-fixture-data';

it('formats Stripe minor units, including zero-decimal display currencies',()=>{
  for(const [currency,unit_amount,value] of [['usd',999,9.99],['jpy',500,500],['isk',500,5],['ugx',500,5]] as const){
    expect(offerAmount({...billingOffer,currency,unit_amount},'en')).toBe(new Intl.NumberFormat('en',{style:'currency',currency}).format(value));
  }
});

describe('Stripe redirect boundaries',()=>{
  it('only accepts official HTTPS checkout and portal links',()=>{
    expect(stripeUrl('https://checkout.stripe.com/c/pay/cs_test_fixture')).toBe('https://checkout.stripe.com/c/pay/cs_test_fixture');
    expect(stripeUrl('https://billing.stripe.com/p/session/fixture',true)).toContain('billing.stripe.com');
    for(const value of ['javascript:alert(1)','/billing/checkout','https://checkout.stripe.com.evil.test/',
      'https://user@checkout.stripe.com/','https://checkout.stripe.com:444/','http://checkout.stripe.com/',
      'https://billing.stripe.com/p/session/fixture'])expect(()=>stripeUrl(value)).toThrow();
    expect(()=>stripeUrl('https://checkout.stripe.com/c/pay/fixture',true)).toThrow();
  });
});
