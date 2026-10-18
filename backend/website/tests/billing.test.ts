import {subscriptionQuotaCopy} from '../src/i18n/subscription-quota';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {annualSavings,annualSavingsForAmounts,amount,billingCopy,billingBenefitCopy,findCheckoutOffer,selectedChannel,hasManagedSubscription,offerBenefits,offerLabel,renewalCopy,trialCopy,type Billing,type BillingOffer} from '../src/lib/billing';
import {quotaPurchase} from '../src/i18n/quota-purchase';
import {membershipBillingType,membershipPricing,offerForInterval} from '../src/lib/billing-cycle';
import {publishedSubscriptions} from '../src/data/published-plans';
import {prepaidMembershipCopy} from '../src/i18n/prepaid-membership';
import {comparisonCopy} from '../src/lib/pricing-comparison';
import {locales} from '../src/i18n/locales';

test('all pricing locales distinguish ordinary and subscription translation models',()=>{
  for(const locale of locales){
    const copy=comparisonCopy(locale);
    assert.ok(copy.model.label.trim(),locale);
    assert.match(copy.model.free,/GPT 6 Luna/,locale);
    assert.match(copy.model.free,/Haiku 5\.5/,locale);
    for(const model of ['GPT 6 Luna','Claude Haiku 5.5','DeepSeekv4 Pro','DeepSeek V4.1 Flash','Gemini 3.8 Flash'])assert.ok(copy.model.lite.includes(model),locale);
    assert.doesNotMatch(copy.model.free,/Gemini|DeepSeek/,locale);
  }
});

test('all purchase locales preserve placeholders and do not describe a page pack as a subscription',()=>{
  const pack={id:'pack',name:'Pages',plan_id:'pack',plan_revision_id:'pack-v1',currency:'usd',unit_amount:123,interval:'once',quota_pages:100,quota_validity_days:null,service_plan_id:'lite',monthly_classic_pages:0,trial_days:0,trial_classic_pages:0,channels:[]} as BillingOffer;
  for(const locale of locales){
    assert.deepEqual(Object.keys(quotaPurchase[locale]),Object.keys(quotaPurchase.en),locale);
    for(const [key,value] of Object.entries(quotaPurchase.en)){
      const translation=quotaPurchase[locale][key as keyof typeof quotaPurchase.en];
      assert.ok(translation.trim(),locale+key);
      assert.deepEqual(translation.match(/\{\d+\}/g)?.sort()??[],value.match(/\{\d+\}/g)?.sort()??[],locale+key);
      // “pages” is the same word in French and English; all prose remains localized.
      if(locale!=='en'&&!(locale==='fr'&&key==='pages'))assert.notEqual(translation,value,locale+key);
    }
    assert.equal(renewalCopy(pack,locale),quotaPurchase[locale].once);
    assert.equal(offerBenefits(pack,locale),quotaPurchase[locale].pages.replace('{0}',(100).toLocaleString(locale)));
    assert.equal(offerLabel(pack,locale),`Pages · ${amount(pack,locale)}`);
    assert.equal(annualSavings(pack,[pack]),null);
  }
});

test('channel selection never changes a pending checkout provider',()=>{
  const offer={channels:[{provider:'stripe',binding_id:'stripe'},{provider:'creem',binding_id:'creem'}]} as BillingOffer;
  assert.equal(selectedChannel(offer,'creem')?.provider,'creem');
  assert.equal(selectedChannel({...offer,channels:[offer.channels[0]]},'creem'),undefined);
  assert.equal(selectedChannel({...offer,channels:[]},'creem'),undefined);
  assert.equal(selectedChannel(offer)?.provider,'stripe');
});

test('checkout quote lookup preserves pending priority and includes prepaid and quota offers',()=>{
  const published=publishedSubscriptions[0];
  const current={...published,id:'same-price',channels:[{provider:'creem' as const,binding_id:'current',trial_days:0,trial_classic_pages:0}]};
  const pending={...current,channels:[{...current.channels[0],provider:'stripe' as const,binding_id:'original'}]};
  const prepaid={...current,id:'prepaid',billing_type:'onetime' as const};
  const pack={...current,id:'pack',interval:'once' as const};
  const billing={subscription_checkout:{price:pending},offers:[current,prepaid],quota_offers:[pack]} as Billing;
  assert.equal(findCheckoutOffer(billing,current.id),pending);
  assert.equal(findCheckoutOffer({...billing,subscription_checkout:null},current.id),current);
  assert.equal(findCheckoutOffer(billing,prepaid.id),prepaid);
  assert.equal(findCheckoutOffer(billing,pack.id),pack);
  assert.equal(findCheckoutOffer(billing,'retired'),undefined);
  assert.equal(findCheckoutOffer({...billing,quota_offers:undefined},pack.id),undefined);
});

test('membership pricing derives exact-mode quotes and display-only fallback without mutating the catalog',()=>{
  const published=structuredClone(publishedSubscriptions),before=structuredClone(published);
  const base=published.find(offer=>offer.plan_id==='plus'&&offer.interval==='quarter')!;
  const recurring={...base,id:'live-quarter',channels:[{provider:'creem' as const,binding_id:'live',trial_days:0,trial_classic_pages:0}]};
  const prepaid={...recurring,id:'prepaid-quarter',billing_type:'onetime' as const};
  const alternate={...prepaid,id:'prepaid-exact'};
  const pro={...prepaid,id:'prepaid-pro',plan_id:'pro'};
  const year={...prepaid,id:'prepaid-year',interval:'year' as const};
  const quotes=[recurring,prepaid,alternate,pro,year],original=structuredClone(quotes);
  const selected=membershipPricing(quotes,published,'quarter','onetime',alternate.id);
  assert.deepEqual(selected.available,[prepaid,alternate,pro,year]);
  assert.deepEqual(selected.plans,[alternate,pro]);
  assert.equal(selected.display,selected.available);
  assert.equal(selected.cycleOffers,selected.available);
  assert.deepEqual(membershipPricing(quotes,published,'quarter','recurring').plans,[recurring]);

  for(const available of [[],[recurring],[year]]){
    const missing=membershipPricing(available,published,'quarter','onetime');
    assert.ok(missing.plans.length>0);
    assert.ok(missing.plans.every(offer=>offer.interval==='quarter'&&offer.billing_type==='onetime'&&offer.channels.length===0));
    assert.ok(missing.display.every(offer=>offer.interval!=='month'));
    assert.notEqual(missing.display,missing.available);
    if(available[0]===year)assert.deepEqual(missing.cycleOffers,[year]);
    else assert.equal(missing.cycleOffers,missing.display);
  }
  assert.deepEqual(quotes,original);
  assert.deepEqual(published,before);
});

test('public pricing never substitutes another cadence or retains a mismatched price ID',()=>{
  const month={id:'monthly',interval:'month'} as BillingOffer,year={id:'yearly',interval:'year'} as BillingOffer;
  const alternative={id:'yearly-alt',interval:'year'} as BillingOffer;
  assert.equal(offerForInterval([month],'year'),undefined);
  assert.equal(offerForInterval([year],'month'),undefined);
  assert.equal(offerForInterval([month,year],'year','monthly'),year);
  assert.equal(offerForInterval([month,year,alternative],'year','yearly-alt'),alternative);
  assert.equal(offerForInterval([],'year'),undefined);
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
  const offer:BillingOffer={id:'test',name:'Sample',plan_id:'plus',plan_revision_id:'plus-v1',currency:'usd',unit_amount:999,interval:'year',monthly_classic_pages:300,trial_days:0,trial_classic_pages:0,channels:[{provider:'stripe',binding_id:'stripe-fixture',trial_days:7,trial_classic_pages:30},{provider:'creem',binding_id:'creem-fixture',trial_days:7,trial_classic_pages:30}]};
  for(const [currency,unit_amount,value] of [['usd',999,9.99],['jpy',500,500],['isk',500,5],['ugx',500,5],['ISK',500,5],['UGX',500,5]] as const)
    assert.equal(amount({...offer,currency,unit_amount},'en'),new Intl.NumberFormat('en',{style:'currency',currency}).format(value));
});

test('public annual discount uses the same comparison math as live offers',()=>{
  assert.deepEqual(annualSavingsForAmounts(599,5999),{regular:7188,saved:1189,percent:16.5});
  for(const [monthly,yearly] of [[0,5999],[599,7188],[599,7200],[599,-1]])assert.equal(annualSavingsForAmounts(monthly,yearly),null);
});

test('quarterly current plans renew without trial and compare four quarters with one year',()=>{
  const base:BillingOffer={id:'plus-quarter',plan_id:'plus',plan_revision_id:'plus-v1',name:'PLUS',currency:'usd',unit_amount:666,interval:'quarter',monthly_classic_pages:2500,trial_days:0,trial_classic_pages:0,channels:[]};
  for(const [quarter,year] of [[666,2399],[999,3599]]){
    const annual={...base,id:'annual',interval:'year' as const,unit_amount:year};
    assert.deepEqual(annualSavings(annual,[{...base,unit_amount:quarter},annual]),{regular:quarter*4,saved:quarter*4-year,percent:9.9});
  }
  assert.equal(renewalCopy(base,'zh-CN'),'每三个月自动续费。');
});

test('prepaid membership keeps the existing monthly allowance and has localized nonrenewing terms',()=>{
  const quarter:BillingOffer={id:'quarter-prepaid',plan_id:'plus',plan_revision_id:'plus-v1',name:'PLUS',currency:'usd',unit_amount:666,interval:'quarter',billing_type:'onetime',monthly_classic_pages:2500,trial_days:0,trial_classic_pages:0,channels:[]};
  const year={...quarter,id:'year-prepaid',interval:'year' as const,unit_amount:2399};
  for(const locale of locales){
    const copy=prepaidMembershipCopy(locale);
    assert.equal(membershipBillingType(locale),locale==='zh-CN'?'onetime':'recurring',locale);
    assert.equal(membershipBillingType(locale,quarter),'onetime',locale);
    assert.equal(membershipBillingType(locale,{...quarter,billing_type:'recurring'}),'recurring',locale);
    assert.equal(renewalCopy(quarter,locale),copy.notice,locale);
    assert.equal(offerBenefits(quarter,locale),subscriptionQuotaCopy(locale).monthly.replace('{0}',(2500).toLocaleString(locale)),locale);
    for(const [key,value] of Object.entries(copy)){
      assert.ok(value.trim(),locale+key);
      assert.deepEqual(value.match(/\{\d+\}/g)?.sort()??[],prepaidMembershipCopy('en')[key as keyof typeof copy].match(/\{\d+\}/g)?.sort()??[],locale+key);
    }
  }
  assert.equal(annualSavings(year,[{...quarter,billing_type:'recurring'}]),null);
  assert.deepEqual(annualSavings(year,[quarter]),{regular:2664,saved:265,percent:9.9});
});

test('annual savings compare the same published benefits and currency',()=>{
  const month:BillingOffer={id:'month',plan_id:'plus',plan_revision_id:'plus-v1',name:'PLUS',currency:'usd',unit_amount:999,interval:'month',monthly_classic_pages:300,trial_days:7,trial_classic_pages:30,channels:[]};
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

test('billing copy omits retired mode benefits for both Lite and legacy quotes',()=>{
  const lite={interval:'year' as const,hourly_image_limit:1200,monthly_classic_pages:null};
  const plus={...lite,hourly_image_limit:null,monthly_classic_pages:300};
  const retiredCopy=/redraw|重绘|重繪|再描画|다시 그리|redessin|redibuj|redesenh|neuzeich|ridisegn|перерис|перемальов|przerys|çizim|vẽ lại|gambar ulang/i;
  for(const locale of locales){
    const copy=billingCopy(locale),benefits=billingBenefitCopy(locale);
    assert.equal(offerBenefits(lite,locale),copy.classic,locale);
    assert.equal(offerBenefits(plus,locale),subscriptionQuotaCopy(locale).monthly.replace('{0}',(300).toLocaleString(locale)),locale);
    assert.equal(renewalCopy(lite,locale),renewalCopy(plus,locale),locale);
    assert.equal(renewalCopy(lite,locale),copy.renew(true),locale);
    assert.equal(trialCopy(7,locale),benefits.trial(7),locale);
    assert.match(trialCopy(7,locale),/7/,locale);
    assert.doesNotMatch([offerBenefits(lite,locale),offerBenefits(plus,locale),renewalCopy(plus,locale),trialCopy(7,locale)].join(' '),retiredCopy,locale);
    for(const key of ['quota','trial'])assert.equal(key in copy,false,`${locale}: billing.${key}`);
    for(const key of ['noRedraw','annual'])assert.equal(key in benefits,false,`${locale}: billingBenefits.${key}`);
  }
});
