import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {load} from 'cheerio';
import {createRequire} from 'node:module';
import * as react from 'react';
import ts from 'typescript';
import QuotaOffers from '../src/components/QuotaOffers';
import {quotaPurchaseCopy} from '../src/i18n/quota-purchase';
import CheckoutButton,{type CheckoutCopy} from '../src/components/CheckoutButton';
import PublishedPlanPricing,{PlanPrice,PublishedPurchaseAvailability,publishedAmount,publishedAmountParts,publishedAnnualDiscount} from '../src/components/PublishedPlanPricing';
import PriceAmount from '../src/components/PriceAmount';
import BillingCycle from '../src/components/BillingCycle';
import FeatureInfo,{tooltipPosition} from '../src/components/FeatureInfo';
import {pricingCopy,publishedPricingCopy} from '../src/lib/pricing';
import {amount,amountParts,billingCopy,trialCopy,type Billing,type BillingOffer,type PendingCheckout} from '../src/lib/billing';
import {comparisonCopy,comparisonRows,extraPagesCopy,paidComparisonValue} from '../src/lib/pricing-comparison';
import {publishedSubscriptions,publishedModels} from '../src/data/published-plans';
import {pricingHighlightsCopy} from '../src/i18n/pricing-highlights';
import PlanComparison from '../src/components/PlanComparison';
import PlanModels from '../src/components/PlanModels';
import {locales,localPath} from '../src/i18n/locales';

test('published subscription prices remain readable without fabricating a purchasable offer',()=>{
  for(const locale of locales)for(const interval of ['quarter','year'] as const){
    const $=load(renderToStaticMarkup(createElement(PublishedPlanPricing,{locale,interval})));
    assert.equal($('.published-plan-pricing').attr('data-billing-interval'),interval,locale);
    assert.equal($('.price .price-value').text(),publishedAmount(interval,locale),locale);
    assert.equal($('.price .price-currency').text(),'US$',locale);
    assert.equal($('.monthly-equivalent').length,1,locale);
    if(interval==='year')assert.ok($('.monthly-equivalent').text().includes(publishedAmount(interval,locale,true)),locale);
    assert.equal($('a,button,[data-purchase-link],[data-billing-catalog="live"]').length,0,locale);
    assert.equal($('.published-pricing-label').length,0,'Currency and published-price disclosures are not repeated in every price block');
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
    assert.deepEqual(rows.map(row=>row.key),['classic','local','model','rate','priority','reading','feedback','requests','early'],locale);
    assert.deepEqual(rows.filter(row=>row.shared).map(row=>row.key),['local','reading'],locale);
    for(const row of rows)assert.equal(row.free===row.lite,row.shared,`${locale}: ${row.key}`);
    assert.ok(rows.find(row=>row.key==='rate')?.lite.includes((2400).toLocaleString(locale)),locale);
  }
});

test('cloud, self-hosted local translation and member support are localized without changing technical feature keys',()=>{
  const english=comparisonCopy('en');
  for(const locale of locales){
    const copy=comparisonCopy(locale);
    assert.match(copy.local.free,/MTU/,locale);
    assert.equal(copy.local.free,copy.local.lite,locale);
    assert.match(copy.local.detail??'',/MTU/,locale);
    for(const key of ['classic','local','feedback','requests'] as const){
      assert.ok(copy[key].label.trim(),`${locale}: ${key}`);
      if(locale!=='en')assert.notEqual(copy[key].label,english[key].label,`${locale}: ${key} must be translated`);
    }
    for(const key of ['feedback','requests'] as const){
      assert.notEqual(copy[key].free,copy[key].lite,`${locale}: ${key} distinguishes ordinary and priority support`);
      if(locale!=='en')for(const tier of ['free','lite'] as const)assert.notEqual(copy[key][tier],english[key][tier],`${locale}: ${key}.${tier} must be translated`);
    }
  }
  assert.equal(comparisonCopy('zh-CN').classic.label,'云端翻译');
  assert.equal(english.classic.label,'Cloud translation');
  assert.match(english.local.detail??'',/connectivity depends on your models and providers/);
  assert.match(english.feedback.detail??'',/does not guarantee a response time/);
  assert.match(english.requests.detail??'',/does not guarantee implementation or a release date/);
});

test('only detailed feature headings have keyboard-addressable localized tooltip buttons',()=>{
  for(const locale of locales){
    const rows=comparisonRows(locale,1200);
    assert.deepEqual(rows.filter(row=>row.detail).map(row=>row.key),['classic','local','rate','feedback','requests'],locale);
    const $=load(renderToStaticMarkup(createElement('div',null,rows.map(row=>createElement('div',{'data-feature':row.key,key:row.key},row.detail?createElement(FeatureInfo,{label:row.label,detail:row.detail}):null)))));
    assert.equal($('.feature-info-trigger').length,5,locale);
    const ids=new Set<string>();
    for(const row of rows){
      const heading=$(`[data-feature="${row.key}"]`),button=heading.find('.feature-info-trigger'),tip=heading.find('[role="tooltip"]');
      assert.equal(button.length,row.detail?1:0,`${locale}: ${row.key}`);
      if(!row.detail)continue;
      assert.equal(button.attr('type'),'button',locale);
      assert.equal(button.attr('aria-label'),row.label,locale);
      assert.equal(button.attr('aria-expanded'),'false',locale);
      assert.equal(button.attr('aria-describedby'),tip.attr('id'),locale);
      assert.equal(button.attr('aria-controls'),tip.attr('id'),locale);
      assert.equal(button.find('svg[aria-hidden="true"][focusable="false"]').length,1,locale);
      assert.equal(tip.is('[hidden]'),true,locale);
      assert.equal(tip.text(),row.detail,locale);
      ids.add(tip.attr('id')!);
      if(locale!=='en')assert.notEqual(row.detail,comparisonRows('en',1200).find(english=>english.key===row.key)?.detail,`${locale}: ${row.key} detail must be translated`);
    }
    assert.equal(ids.size,5,locale);
  }
});

test('feature tips stay inside narrow LTR and RTL viewports and flip above near the bottom',()=>{
  for(const width of [320,390,1280])for(const left of [20,width-48]){
    const anchor={left,right:left+28,top:120,bottom:148},size={width:Math.min(320,width-24),height:180};
    const position=tooltipPosition(anchor,size,{width,height:800});
    assert.ok(position.left>=12&&position.left+size.width<=width-12);
    assert.equal(position.top,148);
    assert.equal(tooltipPosition({...anchor,top:720,bottom:748},size,{width,height:800}).top,540);
  }
});

test('annual discount has a dedicated stable slot in either public billing cadence',()=>{
  assert.equal(publishedAnnualDiscount,9.9);
  for(const locale of locales)for(const value of ['quarter','year'] as const)for(const annualDiscount of [0,publishedAnnualDiscount]){
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
    const $=load(renderToStaticMarkup(createElement(PlanPrice,{locale,interval:'year',offer})));
    assert.equal($('.price .price-value').text(),amount(offer,locale),locale);
    assert.equal($('.billing-total').length,0,'The actual charge is already the main figure');
    assert.ok($('.monthly-equivalent').text().includes(amount({...offer,unit_amount:7199/12},locale)),locale);
    assert.equal($('[data-billing-catalog="published"]').length,0,locale);
  }
});

test('every unavailable purchase state does not advertise a trial and a disabled action',()=>{
  for(const locale of locales)for(const state of ['loading','unavailable','error'] as const){
    const $=load(renderToStaticMarkup(createElement(PublishedPurchaseAvailability,{locale,state})));
    const copy=publishedPricingCopy(locale);
    assert.equal($('.billing-availability').attr('data-state'),state,`${locale}: ${state}`);
    assert.equal($('.billing-status').text(),copy[state],locale);
    assert.equal($('.billing-status').attr('role'),state==='error'?'alert':'status',locale);
    assert.equal($('button[disabled]').length,1,locale);
    assert.equal($('a,[data-purchase-link]').length,0,locale);
    assert.ok(!$.text().includes(trialCopy(7,locale)),locale);
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

const pack:BillingOffer={id:'synthetic-pack',name:'Lite',plan_id:'pages',plan_revision_id:'pack-v1',currency:'usd',unit_amount:700,interval:'once',monthly_classic_pages:0,trial_days:0,trial_classic_pages:0,service_plan_id:'lite',quota_pages:100,quota_validity_days:null,hourly_image_limit:1200,channels:[{provider:'creem',binding_id:'synthetic',trial_days:0,trial_classic_pages:0}]};
const checkoutCopy:CheckoutCopy={busy:'busy',error:'error',before:'before',refund:'refund',renewal:'subscription renewal',resume:'resume original'};
const subscription={...pack,id:'subscription-month',name:'Lite',plan_id:'lite',quota_pages:0,monthly_classic_pages:500,trial_days:7,trial_classic_pages:30,interval:'month' as const};
const original=(price:BillingOffer):PendingCheckout=>({id:'checkout-'+price.id,provider:'creem',price,idempotency_key:price.interval==='once'?'quota-key':null,error:null});
const emptyBilling:Billing={enabled:true,providers:[],provider:null,environment:'test',trial_eligible:true,
  subscription_checkout:null,offers:[subscription],quota_offers:[pack,{...pack,id:'second-pack'}],
  entitlement_expires_at:null,gift:null,subscription:null};
const pricingFile=new URL('../src/components/BillingOffers.tsx',import.meta.url);
const pricingRequire=createRequire(pricingFile);
const pricingCompiled=ts.transpileModule(readFileSync(pricingFile,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function pricingSnapshot(billing:Billing|null,locale='en',selectedPrice=''){
  // Seed only BillingOffers' loaded snapshot. Child controls use real React SSR.
  const states:unknown[]=[billing?.offers??[subscription],false,billing?.quota_offers??[pack],billing,'month',selectedPrice];
  const exports={} as typeof import('../src/components/BillingOffers');
  new Function('require','exports',pricingCompiled)((name:string)=>name==='react'?{...react,useEffect:()=>{},useState:()=>[states.shift(),()=>{}]}:name.endsWith('.css')?{}:pricingRequire(name),exports);
  return load(renderToStaticMarkup(createElement(exports.default,{locale,accountHref:localPath('/account/',locale as typeof locales[number]),downloadHref:'/download/',checkoutCopy,
    free:{name:'Free',description:'Free',action:'Download',note:'Free',priceLabel:'free'}})));
}

test('page packs show exact page counts and expiry without recurring or unlimited subscription claims in all locales',()=>{
  for(const locale of locales)for(const days of [null,30]){
    const copy=quotaPurchaseCopy(locale),quote={...pack,quota_validity_days:days};
    const $=load(renderToStaticMarkup(createElement(QuotaOffers,{locale,offers:[quote],accountHref:localPath('/account/',locale),checkoutCopy})));
    assert.equal($('.quota-offer').length,1);
    assert.equal($('.quota-offer-quantity strong').text(),(100).toLocaleString(locale),locale);
    assert.equal($('.quota-offer-price .price-value').text(),amount(quote,locale),locale);
    assert.ok($.text().includes(copy.pages.replace('{0}',(100).toLocaleString(locale))),locale);
    assert.ok($.text().includes(days===null?copy.noExpiry:copy.validity.replace('{0}',(30).toLocaleString(locale))),locale);
    assert.ok($.text().includes(copy.oneTime),locale);
    assert.equal($('.quota-offers-heading').text(),copy.title,locale);
    assert.equal($('.quota-offers-heading .quota-purchase-kind').length,0,locale);
    assert.ok(!('noRenewal' in copy),locale);
    assert.ok($.text().includes(copy.service.replace('{0}','Lite')),locale);
    assert.ok($.text().includes(copy.hourly.replace('{0}',(1200).toLocaleString(locale))),locale);
    assert.equal($('.quota-offer-features li').length,3,locale);
    assert.equal($('.quota-offer .quota-icon[aria-hidden="true"][focusable="false"]').length,4,locale);
    assert.ok(!$.text().includes(billingCopy(locale).classic),locale);
    assert.ok(!$.text().includes('subscription renewal'),locale);
    assert.equal($('[data-purchase-link]').attr('href'),localPath('/pricing/?price=synthetic-pack',locale));
    assert.ok($('[data-purchase-link]').text().includes(copy.action),locale);
  }
});

test('pack cards share one complete policy disclosure without repeating paragraphs in each card',()=>{
  for(const locale of locales){
    const copy=quotaPurchaseCopy(locale),accountHref=localPath('/account/',locale);
    const $=load(renderToStaticMarkup(createElement(QuotaOffers,{locale,offers:[pack,{...pack,id:'expiring',quota_pages:50,quota_validity_days:30}],accountHref,checkoutCopy})));
    assert.equal($('.quota-offer p,.quota-offer .trial-note').length,0,locale);
    assert.equal($('.quota-offer [data-purchase-link]').length,2,locale);
    assert.equal($('.quota-offer-legal a').attr('href'),localPath('/refund/',locale));
    assert.equal($(`a[href="${localPath('/refund/',locale)}"]`).length,1,locale);
    for(const rule of [copy.subscription,copy.usage,copy.validityStart,copy.tax,copy.terms])assert.ok($('.quota-offer-policy').text().includes(rule),`${locale}: ${rule}`);
    const subscription=load(renderToStaticMarkup(createElement(CheckoutButton,{priceId:'subscription',accountHref,label:'subscribe',copy:checkoutCopy})));
    assert.equal(subscription('.trial-note').length,1,'Existing subscription disclosure stays enabled by default');
    assert.ok(subscription('.trial-note').text().includes(checkoutCopy.renewal));
  }
});

test('quota presentation uses shared theme tokens and scopes every rule away from subscription cards',()=>{
  const css=readFileSync(new URL('../src/styles/quota-offers.css',import.meta.url),'utf8');
  for(const match of css.matchAll(/([^{}]+)\{/g)){
    const selector=match[1].trim();
    if(!selector.startsWith('@media'))assert.ok(selector.startsWith('.quota-offers'),selector);
  }
  assert.doesNotMatch(css,/#(?:[a-f\d]{3,8})\b|url\(/i,'No alternate hard-coded palette or bitmap assets');
  for(const token of ['--comic-panel-radius','--comic-panel-padding','--accent','--surface','--ink','--muted'])assert.ok(css.includes(`var(${token})`),token);
});

test('no invented pack is rendered without a sellable quote; all sellable packs keep independent purchase actions',()=>{
  const props={locale:'en',accountHref:'/en/account/',checkoutCopy};
  for(const offers of [[],[{...pack,channels:[]}],[{...pack,interval:'month' as const}]]){
    assert.equal(renderToStaticMarkup(createElement(QuotaOffers,{...props,offers})), '');
  }
  const $=load(renderToStaticMarkup(createElement(QuotaOffers,{...props,offers:[pack,{...pack,id:'other-pack'}]})));
  assert.equal($('.quota-offer').length,2);
  assert.deepEqual($('[data-purchase-link]').toArray().map(link=>$(link).attr('href')),['/en/pricing/?price=synthetic-pack','/en/pricing/?price=other-pack']);
  assert.ok(!$('[data-purchase-link]').text().includes(checkoutCopy.resume!));
  const blocked=load(renderToStaticMarkup(createElement(QuotaOffers,{...props,offers:[pack],blocked:true})));
  assert.equal(blocked('[data-purchase-link]').attr('aria-disabled'),'true');
});

test('subscription recovery does not hide or disable any quota purchase action',()=>{
  for(const subscription_checkout of [null,original(subscription)]){
    const $=pricingSnapshot({...emptyBilling,subscription_checkout});
    assert.equal($('.subscription-card.paid [data-purchase-link]').attr('aria-disabled'),undefined);
    for(const link of $('.quota-offer [data-purchase-link]').toArray())assert.equal($(link).attr('aria-disabled'),undefined);
    assert.equal($('.quota-offer').length,2);
    assert.ok(!$('.quota-offer [data-purchase-link]').text().includes('resume original'));
    if(!subscription_checkout){
      assert.equal($('.billing-cycle[disabled]').length,0);
      assert.ok(!$('.subscription-card.paid [data-purchase-link]').text().includes('resume original'));
    }else assert.ok($('.subscription-card.paid [data-purchase-link]').text().includes('resume original'));
  }
});

test('every locale keeps original subscription recovery separate from every new quota quote',()=>{
  const sub={...subscription,id:'retired-year',interval:'year' as const};
  for(const locale of locales){
    const $=pricingSnapshot({...emptyBilling,subscription_checkout:original(sub)},locale,pack.id);
    const subscriptionButton=$('.subscription-card.paid [data-purchase-link]'),quotaButton=$('.quota-offer [data-purchase-link]');
    assert.equal(subscriptionButton.attr('href'),localPath('/pricing/?price=retired-year',locale));
    assert.equal(quotaButton.attr('href'),localPath('/pricing/?price=synthetic-pack',locale));
    assert.ok(subscriptionButton.text().includes('resume original'));assert.ok(!quotaButton.text().includes('resume original'));
    assert.equal(subscriptionButton.attr('aria-disabled'),undefined);assert.equal(quotaButton.attr('aria-disabled'),undefined);
    assert.equal($('.quota-offer').length,2);assert.equal($('.billing-cycle[disabled]').length,1);
  }
});

test('a retired selected quote gets one manual recovery action only for a signed-in pricing snapshot',()=>{
  for(const locale of locales){
    const $=pricingSnapshot(emptyBilling,locale,'retired-pack');
    assert.equal($('.billing-recovery [data-purchase-link]').length,1);
    assert.equal($('.billing-recovery [data-purchase-link]').attr('href'),localPath('/pricing/?price=retired-pack',locale));
    assert.ok($('.billing-recovery').text().includes(checkoutCopy.resume!));
    assert.equal($('.quota-offer').length,2);
  }
  for(const selected of ['',pack.id,subscription.id,'../invalid'])assert.equal(pricingSnapshot(emptyBilling,'en',selected)('.billing-recovery').length,0);
  assert.equal(pricingSnapshot(null,'en','retired-pack')('.billing-recovery').length,0);
  assert.match(readFileSync(pricingFile,'utf8'),/className="billing-recovery"[^\n]*continueAfterLogin=\{false\}/);
});


test('finite and unlimited subscription cards use the catalog rather than product names',()=>{
  const unlimited={...subscription,id:'pro-month',plan_id:'pro',name:'Pro',monthly_classic_pages:null,trial_classic_pages:null};
  const $=pricingSnapshot({...emptyBilling,offers:[subscription,unlimited]});
  assert.equal($('.subscription-card').length,3);
  assert.match($('.subscription-card.paid').eq(0).find('.subscription-allowance').text(),/500/);
  assert.ok($('.subscription-card.paid').eq(1).find('.subscription-allowance').text().includes(billingCopy('en').classic));
  assert.match($('.subscription-card.paid').eq(0).find('.trial-note').text(),/30/);
  assert.equal($('.subscription-card.paid [data-purchase-link]').length,2);
});

test('cards distinguish included free models from paid additions in every language',()=>{
  for(const locale of locales)for(const paid of [false,true]){
    const copy=pricingHighlightsCopy(locale);
    const $=load(renderToStaticMarkup(createElement(PlanModels,{locale,paid})));
    assert.deepEqual($('ul').first().find('bdi').toArray().map(el=>$(el).text()),publishedModels.free,locale);
    assert.deepEqual($('ul').last().find('bdi').toArray().map(el=>$(el).text()),publishedModels.paid_extra,locale);
    assert.equal($('ul').last().attr('data-included'),String(paid),locale);
    assert.equal($('h3').last().text(),paid?copy.paidModels:copy.paidOnly,locale);
    assert.equal($('.icon-check').length,publishedModels.free.length+(paid?publishedModels.paid_extra.length:0),locale);
  }
});

test('one accessible comparison separates all models and both paid quotas without repeating tooltips',()=>{
  const plans=publishedSubscriptions.filter(offer=>offer.interval==='quarter');
  for(const locale of locales){
    const $=load(renderToStaticMarkup(createElement(PlanComparison,{locale,plans,freeName:'Free'})));
    const text=pricingHighlightsCopy(locale);
    assert.deepEqual($('thead th').toArray().slice(1).map(el=>$(el).text()),['Free','PLUS','Pro']);
    assert.equal($('[role="region"][tabindex="0"]').length,1);
    assert.equal($('caption').text(),comparisonCopy(locale).feature);
    assert.equal($('.feature-info-trigger').length,5,'one tooltip per detailed feature, not per plan');
    for(const model of [...publishedModels.free,...publishedModels.paid_extra]){
      const cells=$(`tr[data-model="${model}"] td`);
      assert.deepEqual(cells.toArray().map(el=>$(el).text()),[publishedModels.free.includes(model)?text.included:'−'+text.notIncluded,text.included,text.included]);
    }
    assert.ok($('[data-feature="classic"] td').eq(1).text().includes((2500).toLocaleString(locale)));
    assert.ok($('[data-feature="classic"] td').eq(2).text().includes((4000).toLocaleString(locale)));
  }
});

test('larger paid plans highlight their actual monthly difference, not invented speed or model privileges',()=>{
  const plans=publishedSubscriptions.filter(offer=>offer.interval==='quarter');
  for(const locale of locales){
    assert.equal(extraPagesCopy(plans[0],plans,locale),'');
    assert.ok(extraPagesCopy(plans[1],plans,locale).includes((1500).toLocaleString(locale)));
    assert.ok(extraPagesCopy(plans[1],plans,locale).includes('PLUS'));
    assert.equal(extraPagesCopy({...plans[1],monthly_classic_pages:null},plans,locale),'');
    assert.equal(extraPagesCopy(plans[1],[plans[1]],locale),'');
    assert.equal(extraPagesCopy(plans[1],[{...plans[0],monthly_classic_pages:4000},plans[1]],locale),'');
    const rate=comparisonRows(locale,0).find(row=>row.key==='rate')!;
    const value=paidComparisonValue(rate,{...plans[0],hourly_image_limit:1200},locale);
    assert.ok(value.includes((1200).toLocaleString(locale)));
    assert.ok(value.includes('100'),'hourly limits must not replace the minute limit');
  }
});

test('annual price tags only advertise verified comparable discounts and use decorative SVG',()=>{
  for(const locale of locales)for(const plan of ['plus','pro']){
    const offer=publishedSubscriptions.find(item=>item.plan_id===plan&&item.interval==='year')!;
    const $=load(renderToStaticMarkup(createElement(PlanPrice,{locale,interval:'year',offer,offers:publishedSubscriptions})));
    assert.equal($('.price-discount').text(),pricingCopy(locale).save(publishedAnnualDiscount),locale);
    assert.equal($('.price-discount svg[aria-hidden="true"][focusable="false"]').length,1);
    assert.equal($('.monthly-equivalent svg[aria-hidden="true"]').length,1);
    assert.equal($('.price .price-value').text(),publishedAmountParts('year',locale,false,offer.unit_amount).map(part=>part.value).join(''));
    for(const offers of [[],[{...offer,interval:'quarter' as const,plan_revision_id:'different'}],[{...offer,interval:'quarter' as const,currency:'eur'}]]){
      const html=load(renderToStaticMarkup(createElement(PlanPrice,{locale,interval:'year',offer,offers})));
      assert.equal(html('.price-discount').length,0,'No comparable quote means no discount claim');
    }
  }
});

test('visual advantages distinguish paid additions and quota differences, not shared benefits',()=>{
  const plans=publishedSubscriptions.filter(offer=>offer.interval==='quarter');
  const $=load(renderToStaticMarkup(createElement(PlanComparison,{locale:'zh-CN',plans,freeName:'免费'})));
  for(const model of publishedModels.free)assert.equal($(`tr[data-model="${model}"] [data-advantage="true"]`).length,0);
  for(const model of publishedModels.paid_extra){
    assert.equal($(`tr[data-model="${model}"] [data-advantage="true"]`).length,2);
    assert.equal($(`tr[data-model="${model}"] [data-unavailable="true"]`).length,1);
  }
  for(const key of ['reading','local'])assert.equal($(`tr[data-feature="${key}"] [data-advantage="true"]`).length,0);
  for(const key of ['classic','rate','priority','feedback','requests','early'])assert.equal($(`tr[data-feature="${key}"] [data-advantage="true"]`).length,2);
  assert.equal($('[data-more-pages="true"]').length,1);
  assert.match($('.comparison-delta').text(),/1,500/);
});
