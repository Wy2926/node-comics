import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {load} from 'cheerio';
import PublishedLitePricing,{LitePrice,PublishedPurchaseAvailability,publishedAmount,publishedAmountParts,publishedAnnualDiscount} from '../src/components/PublishedLitePricing';
import PriceAmount from '../src/components/PriceAmount';
import BillingCycle from '../src/components/BillingCycle';
import {publishedLite} from '../src/data/published-lite';
import {pricingCopy,publishedPricingCopy} from '../src/lib/pricing';
import {amount,amountParts,trialCopy,type BillingOffer} from '../src/lib/billing';
import {comparisonRows} from '../src/lib/pricing-comparison';
import {locales} from '../src/i18n/locales';

test('published Lite prices remain readable without fabricating a purchasable offer',()=>{
  for(const locale of locales)for(const interval of ['month','year'] as const){
    const $=load(renderToStaticMarkup(createElement(PublishedLitePricing,{locale,interval})));
    assert.equal($('.published-lite-pricing').attr('data-billing-interval'),interval,locale);
    assert.equal($('.price-value').text(),publishedAmount(interval,locale),locale);
    assert.equal($('.price-currency').text(),'US$',locale);
    assert.equal($('.monthly-equivalent').length,interval==='year'?1:0,locale);
    if(interval==='year')assert.ok($('.monthly-equivalent').text().includes(publishedAmount(interval,locale,true)),locale);
    assert.equal($('a,button,[data-purchase-link],[data-billing-catalog="live"]').length,0,locale);
    assert.equal($('.published-pricing-label').text(),publishedPricingCopy(locale).label,locale);
  }
});

test('price hierarchy preserves localized currency order, spaces and minor units',()=>{
  for(const locale of locales)for(const currency of ['usd','eur','jpy','ISK','UGX','bhd']){
    const offer={currency,unit_amount:5999};
    const $=load(renderToStaticMarkup(createElement(PriceAmount,{parts:amountParts(offer,locale)})));
    assert.equal($('.price-value').text(),amount(offer,locale),`${locale} ${currency}`);
    assert.equal($('.price-currency').length,1,`${locale} ${currency}`);
    assert.equal($('.price-value').children(':not(.price-currency)').length,0,'numeric text must not inherit the legacy small-span style');
    assert.ok($('.price-currency').text().length>0);
  }
  for(const locale of locales){
    const $=load(renderToStaticMarkup(createElement(PriceAmount,{parts:publishedAmountParts('free',locale)})));
    assert.equal($('.price-value').text(),'US$0',locale);
    assert.equal($('.price-currency').text(),'US$',locale);
  }
});

test('only common benefits are marked shared, while paid advantages retain their full copy',()=>{
  for(const locale of locales){
    const rows=comparisonRows(locale,2400);
    assert.deepEqual(rows.filter(row=>row.shared).map(row=>row.key),['reading'],locale);
    for(const row of rows)assert.equal(row.free===row.lite,row.shared,`${locale}: ${row.key}`);
    assert.ok(rows.find(row=>row.key==='rate')?.lite.includes((2400).toLocaleString(locale)),locale);
  }
});

test('annual discount has a dedicated stable slot in either public billing cadence',()=>{
  assert.equal(publishedAnnualDiscount,16.5);
  for(const locale of locales)for(const value of ['month','year'] as const)for(const annualDiscount of [0,publishedAnnualDiscount]){
    const $=load(renderToStaticMarkup(createElement(BillingCycle,{offers:[],value,onChange:()=>{},locale,preview:true,annualDiscount})));
    assert.equal($('.billing-cycle-picker > .billing-cycle-saving').length,1,locale);
    assert.equal($('.billing-cycle .annual-badge').length,0,locale);
    assert.equal($('.annual-badge').text(),annualDiscount?pricingCopy(locale).save(annualDiscount):'',locale);
    assert.equal($('input:checked').attr('value'),value,locale);
    assert.equal($('input:disabled').length,0,locale);
  }
});

test('live annual quotes show the full charge before the monthly equivalent',()=>{
  const offer={unit_amount:7199,currency:'USD',interval:'year'} as BillingOffer;
  for(const locale of locales){
    const $=load(renderToStaticMarkup(createElement(LitePrice,{locale,interval:'year',offer})));
    assert.equal($('.price-value').text(),amount(offer,locale),locale);
    assert.ok($('.billing-total').text().includes(amount(offer,locale)),locale);
    assert.ok($('.monthly-equivalent').text().includes(amount({...offer,unit_amount:7199/12},locale)),locale);
    assert.equal($('[data-billing-catalog="published"]').length,0,locale);
  }
});

test('every unavailable purchase state keeps the card-backed trial and a disabled action',()=>{
  for(const locale of locales)for(const state of ['loading','unavailable','error'] as const){
    const $=load(renderToStaticMarkup(createElement(PublishedPurchaseAvailability,{locale,state})));
    const copy=publishedPricingCopy(locale);
    assert.equal($('.billing-availability').attr('data-state'),state,`${locale}: ${state}`);
    assert.equal($('.billing-status').text(),copy[state],locale);
    assert.equal($('.billing-status').attr('role'),state==='error'?'alert':'status',locale);
    assert.equal($('button[disabled]').length,1,locale);
    assert.equal($('a,[data-purchase-link]').length,0,locale);
    assert.ok($.text().includes(trialCopy(publishedLite.trialDays,locale)),locale);
    assert.ok($.text().includes(copy.tax),locale);
  }
});

test('pricing presentation rules stay scoped and do not duplicate the former global block',()=>{
  const css=readFileSync(new URL('../src/styles/pricing.css',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  for(const match of css.matchAll(/([^{}]+)\{/g)){
    const selector=match[1].trim();
    if(selector.startsWith('@media'))continue;
    // Commas inside :is() are not separate selectors; every rule begins in the pricing frame.
    assert.ok(selector.startsWith('.pricing-comparison'),selector);
  }
  const global=readFileSync(new URL('../src/styles/global.css',import.meta.url),'utf8');
  assert.doesNotMatch(global,/\.pricing-comparison|\.plan-comparison|\.pricing-actions/);
  assert.match(css,/table-layout:\s*fixed/);
  assert.match(css,/\.pricing-comparison\s+\.feature-column\s*\{/);
});
