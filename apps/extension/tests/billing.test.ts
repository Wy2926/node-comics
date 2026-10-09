import {afterEach,describe,it,expect,vi} from 'vitest';
import {Api} from '../src/api';
import {paymentUrl,offerAmount,hasManagedSubscription,pricingUrl} from '../src/billing';
import {billingOffer} from './billing-fixture-data';

afterEach(()=>vi.unstubAllGlobals());

it('uses one localized website pricing destination without a payment token or direct checkout',()=>{
  expect(pricingUrl('zh-CN')).toBe('https://comics.nodelane.net/pricing/');
  expect(pricingUrl('en')).toBe('https://comics.nodelane.net/en/pricing/');
  expect(pricingUrl('pt-BR')).toBe('https://comics.nodelane.net/pt-br/pricing/');
  expect(pricingUrl('zh-TW')).toBe('https://comics.nodelane.net/zh-tw/pricing/');
  const api=new Api('https://billing.test','fixture-token');
  expect('startCheckout' in api).toBe(false);
  expect('billingCatalog' in api).toBe(false);
});

it('keeps subscription management on the original provider',async()=>{
  const fetch=vi.fn().mockResolvedValue(Response.json({provider:'creem',url:'https://creem.io/my-orders/login/fixture'}));
  vi.stubGlobal('fetch',fetch);
  await new Api('https://billing.test','fixture-token').billingPortal('creem');
  const [url,init]=fetch.mock.calls[0];
  expect(url).toBe('https://billing.test/v1/billing/portal');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({provider:'creem'});
  expect(init.headers.get('Authorization')).toBe('Bearer fixture-token');
});

it('formats Stripe minor units, including zero-decimal display currencies',()=>{
  for(const [currency,unit_amount,value] of [['usd',999,9.99],['jpy',500,500],['isk',500,5],['ugx',500,5]] as const){
    expect(offerAmount({...billingOffer,currency,unit_amount},'en')).toBe(new Intl.NumberFormat('en',{style:'currency',currency}).format(value));
  }
});

it('allows another purchase after expiry or revoked terminal access',()=>{
  const now=Date.parse('2026-09-20T00:00:00Z');
  for(const status of ['active','trialing','paused','past_due','unpaid','incomplete','scheduled_cancel'])expect(hasManagedSubscription(status,null,now)).toBe(true);
  for(const status of ['canceled','expired','incomplete_expired']){
    expect(hasManagedSubscription(status,null,now)).toBe(false);
    expect(hasManagedSubscription(status,'2026-09-19T00:00:00Z',now)).toBe(false);
    expect(hasManagedSubscription(status,'2026-09-21T00:00:00Z',now)).toBe(true);
  }
  expect(hasManagedSubscription(undefined,null,now)).toBe(false);
});

describe('Creem redirect boundaries',()=>{
  it('only allows official hosted checkouts and customer portals on the selected provider',()=>{
    for(const value of ['https://creem.io/checkout/prod_fixture','https://www.creem.io/test/checkout/prod_fixture'])expect(paymentUrl(value,'creem')).toBe(value);
    for(const value of ['https://creem.io/my-orders/login/fixture','https://www.creem.io/test/my-orders/login/fixture'])expect(paymentUrl(value,'creem',true)).toBe(value);
    for(const value of ['https://creem.io.evil.test/checkout/x','https://creem.io/dashboard','https://creem.io/my-orders/login/x','https://user@creem.io/checkout/x','http://creem.io/checkout/x','https://creem.io:444/checkout/x','https://checkout.stripe.com/c/pay/x'])expect(()=>paymentUrl(value,'creem')).toThrow();
    expect(()=>paymentUrl('https://creem.io/checkout/fixture','creem',true)).toThrow();
    expect(()=>paymentUrl('https://creem.io/checkout/fixture','stripe')).toThrow();
  });
});

describe('Stripe redirect boundaries',()=>{
  it('only accepts official HTTPS checkout and portal links',()=>{
    expect(paymentUrl('https://checkout.stripe.com/c/pay/cs_test_fixture','stripe')).toBe('https://checkout.stripe.com/c/pay/cs_test_fixture');
    expect(paymentUrl('https://billing.stripe.com/p/session/fixture','stripe',true)).toContain('billing.stripe.com');
    for(const value of ['javascript:alert(1)','/billing/checkout','https://checkout.stripe.com.evil.test/',
      'https://user@checkout.stripe.com/','https://checkout.stripe.com:444/','http://checkout.stripe.com/',
      'https://billing.stripe.com/p/session/fixture'])expect(()=>paymentUrl(value,'stripe')).toThrow();
    expect(()=>paymentUrl('https://checkout.stripe.com/c/pay/fixture','stripe',true)).toThrow();
  });
});
