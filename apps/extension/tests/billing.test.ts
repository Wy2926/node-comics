import {afterEach,it,expect,vi} from 'vitest';
import {Api} from '../src/api';
import {pricingUrl,openPricing} from '../src/billing';
import {installDictionary} from '../src/i18n/runtime';

afterEach(()=>vi.unstubAllGlobals());

it('opens reader upgrades directly on website pricing without an opener',()=>{
  const open=vi.fn();vi.stubGlobal('window',{open});installDictionary('zh-CN',{});
  openPricing();
  expect(open).toHaveBeenCalledWith('https://comics.nodelane.net/pricing/','_blank','noopener,noreferrer');
});

it('sends all new purchases to localized website pricing without plugin billing operations',()=>{
  expect(pricingUrl('zh-CN')).toBe('https://comics.nodelane.net/pricing/');
  expect(pricingUrl('en')).toBe('https://comics.nodelane.net/en/pricing/');
  expect(pricingUrl('pt-BR')).toBe('https://comics.nodelane.net/pt-br/pricing/');
  expect(pricingUrl('zh-TW')).toBe('https://comics.nodelane.net/zh-tw/pricing/');
  const api=new Api('https://billing.test','fixture-token');
  for(const method of ['startCheckout','billingCatalog','billingStatus','billingPortal','cancelRenewal','syncBilling'])expect(method in api).toBe(false);
});

it('requests a bounded private purchase page with encoded cursor and cancellation',async()=>{
  const fetch=vi.fn().mockResolvedValue(Response.json({items:[],next_cursor:null}));
  vi.stubGlobal('fetch',fetch);
  const controller=new AbortController();
  await new Api('https://billing.test','fixture-token').quotaPurchases('page&id',controller.signal);
  const [url,init]=fetch.mock.calls[0];
  expect(url).toBe('https://billing.test/v1/me/quota-purchases?limit=20&cursor=page%26id');
  expect(init.signal.aborted).toBe(false);controller.abort();expect(init.signal.aborted).toBe(true);
  expect(init.headers.get('Authorization')).toBe('Bearer fixture-token');
});
