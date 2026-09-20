import {afterEach,describe,it,expect,vi} from 'vitest';
import {Api} from '../src/api';
import {paymentUrl,offerAmount,selectedChannel,hasManagedSubscription} from '../src/billing';
import {billingOffer} from './billing-fixture-data';

afterEach(()=>vi.unstubAllGlobals());

it('loads public quotes without authentication and submits the selected price and channel',async()=>{
  const fetch=vi.fn().mockResolvedValue(Response.json({enabled:true,offers:[billingOffer]}));
  vi.stubGlobal('fetch',fetch);
  const catalog=await new Api('https://billing.test').billingCatalog();
  expect(catalog.offers).toEqual([billingOffer]);
  expect(fetch.mock.calls[0][0]).toBe('https://billing.test/v1/billing/catalog');
  expect(fetch.mock.calls[0][1].headers.has('Authorization')).toBe(false);
  for(const priceId of ['plus-month-v1','plus-year-v1']){
    fetch.mockResolvedValueOnce(Response.json({provider:'creem',environment:'test',trial:true,checkout_url:'https://creem.io/test/checkout/fixture'}));
    await new Api('https://billing.test','fixture-token').startCheckout(priceId,'creem');
    const [url,init]=fetch.mock.calls.at(-1)!;
    expect(url).toBe('https://billing.test/v1/billing/checkouts');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({price_id:priceId,provider:'creem'});
    expect(init.headers.get('Authorization')).toBe('Bearer fixture-token');
  }
});

it('formats Stripe minor units, including zero-decimal display currencies',()=>{
  for(const [currency,unit_amount,value] of [['usd',999,9.99],['jpy',500,500],['isk',500,5],['ugx',500,5]] as const){
    expect(offerAmount({...billingOffer,currency,unit_amount},'en')).toBe(new Intl.NumberFormat('en',{style:'currency',currency}).format(value));
  }
});

it('keeps pending checkouts on the original channel even when another is preferred',()=>{
  expect(selectedChannel(billingOffer,'creem')?.provider).toBe('creem');
  expect(selectedChannel(billingOffer,'stripe','creem')?.provider).toBe('creem');
  expect(selectedChannel({...billingOffer,channels:billingOffer.channels.slice(0,1)},'stripe','creem')).toBeUndefined();
  expect(selectedChannel({...billingOffer,channels:[]},'creem')).toBeUndefined();
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
