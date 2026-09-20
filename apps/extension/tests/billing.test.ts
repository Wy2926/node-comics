import {describe,it,expect} from 'vitest';
import {stripeUrl} from '../src/billing';

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
