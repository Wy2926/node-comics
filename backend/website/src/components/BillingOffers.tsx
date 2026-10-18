import {useEffect,useState} from 'react';
import {amount,annualSavings,billingCopy,billingBenefitCopy,offerBenefits,offerLabel,renewalCopy,trialCopy,findCheckoutOffer,isOneTimePrice,membershipCheckoutBlocked,manageLabel,type BillingOffer,type Billing,type BillingType} from '../lib/billing';
import {pricingCopy,publishedPricingCopy} from '../lib/pricing';
import {comparisonCopy,comparisonRows,extraPagesCopy,paidComparisonValue} from '../lib/pricing-comparison';
import {pricingHighlightsCopy} from '../i18n/pricing-highlights';
import {checkoutStatusCopy} from '../i18n/commerce';
import {publishedSubscriptions,publishedPacks} from '../data/published-plans';
import BillingCycle,{type BillingInterval} from './BillingCycle';
import {membershipBillingType,membershipPricing,offerForInterval} from '../lib/billing-cycle';
import {PlanPrice,PublishedPurchaseAvailability,publishedAmountParts,publishedAnnualDiscount} from './PublishedPlanPricing';
import PriceAmount from './PriceAmount';
import CheckoutButton, { type CheckoutCopy } from './CheckoutButton';
import QuotaOffers from './QuotaOffers';
import PlanModels from './PlanModels';
import PlanComparison from './PlanComparison';
import {quotaPurchaseCopy} from '../i18n/quota-purchase';
import {subscriptionQuotaCopy} from '../i18n/subscription-quota';
import {prepaidMembershipCopy} from '../i18n/prepaid-membership';
import '../styles/pricing.css';
import '../styles/quota-offers.css';

interface Props {
  locale:string;
  accountHref:string;
  downloadHref:string;
  checkoutCopy:CheckoutCopy;
  free:{name:string;description:string;action:string;note:string;priceLabel:string};
}

export default function BillingOffers({locale,accountHref,downloadHref,free,checkoutCopy}:Props){
  const [offers,setOffers]=useState<BillingOffer[]>(),[error,setError]=useState(false);
  const [quotaOffers,setQuotaOffers]=useState<BillingOffer[]>([]);
  const [billing,setBilling]=useState<Billing|null>();
  const [preferred,setPreferred]=useState<BillingInterval>();
  const [selectedPrice,setSelectedPrice]=useState('');
  const [preferredType,setPreferredType]=useState<BillingType>();
  const copy=billingCopy(locale),benefits=billingBenefitCopy(locale),text=pricingCopy(locale),comparison=comparisonCopy(locale);
  const quota=subscriptionQuotaCopy(locale);
  const prepaid=prepaidMembershipCopy(locale);
  const highlights=pricingHighlightsCopy(locale);
  const buttonCopy={...checkoutCopy,...checkoutStatusCopy(locale)};
  const prepaidButtonCopy={...buttonCopy,renewal:'',retry:quotaPurchaseCopy(locale).retry,retryHint:quotaPurchaseCopy(locale).retryHint};
  useEffect(()=>{
    setSelectedPrice(new URLSearchParams(location.search).get('price')??'');
    const controller=new AbortController();
    let disposed=false;
    let unsubscribe:(()=>void)|undefined,epoch=0;
    const timeout=setTimeout(()=>{setError(true);controller.abort();},10000);
    fetch('/v1/billing/catalog',{signal:controller.signal,cache:'no-store'}).then(async r=>{
      if(!r.ok)throw Error();
      const catalog=await r.json();
      if(!Array.isArray(catalog.offers))throw Error();
      setOffers(catalog.offers.filter((offer:BillingOffer)=>offer.interval!=='once'&&offer?.channels?.length>0));
      setQuotaOffers(Array.isArray(catalog.quota_offers)?catalog.quota_offers:[]);
    }).catch(()=>{if(!controller.signal.aborted)setError(true);}).finally(()=>clearTimeout(timeout));
    // Account-aware checkout belongs only to the pricing page. Public home
    // previews do not load identity or billing status.
    void import('../lib/direct-checkout').then(({checkoutStatus,subscribeAuth})=>{
      if(disposed)return;
      const load=async()=>{
        const current=++epoch;
        setBilling(undefined);
        try{const value=await checkoutStatus();if(!disposed&&current===epoch)setBilling(value);}
        catch{if(!disposed&&current===epoch)setBilling(null);}
      };
      unsubscribe=subscribeAuth(()=>void load());
      void load();
    }).catch(()=>{if(!disposed)setBilling(null);});
    return()=>{disposed=true;unsubscribe?.();clearTimeout(timeout);controller.abort();};
  },[]);
  const pending=[billing?.pending_checkout,billing?.subscription_checkout].find(checkout=>checkout&&checkout.price.interval!=='once')?.price;
  const quotes=(billing?.offers??(error?[]:offers??[])).filter(offer=>offer.interval!=='once'&&offer.id!==pending?.id);
  if(pending)quotes.push(pending);
  const requested=quotes.find(offer=>offer.id===selectedPrice);
  const billingType=requested||pending?membershipBillingType(locale,requested,pending):preferredType??membershipBillingType(locale);
  const oneTime=billingType==='onetime';
  const interval=requested?.interval==='month'||requested?.interval==='quarter'||requested?.interval==='year'?requested.interval:preferred??(pending?.interval!=='once'?pending?.interval:undefined)??'quarter';
  const {available,display,plans,cycleOffers}=membershipPricing(quotes,publishedSubscriptions,interval,billingType,selectedPrice||(preferred===undefined?pending?.id:undefined));
  const pendingConflict=!!pending&&isOneTimePrice(pending)!==oneTime;
  const resumePending=!!pending&&!plans.some(offer=>offer.id===pending.id&&(!billing||!membershipCheckoutBlocked(billing,offer)));
  const recoverSelected=!!billing&&/^[\w-]{1,36}$/.test(selectedPrice)&&
    (!findCheckoutOffer(billing,selectedPrice)||
      !!requested&&isOneTimePrice(requested)&&membershipCheckoutBlocked(billing,requested));
  const rows=comparisonRows(locale,0).filter(row=>row.key==='rate'||row.key==='priority');
  const annual=offerForInterval(available,'year',selectedPrice);
  const discount=annual?annualSavings(annual,available)?.percent??0:available.length?0:publishedAnnualDiscount;
  return <div className="pricing-comparison">
    <BillingCycle offers={cycleOffers} value={interval} onChange={value=>{setPreferred(value);setPreferredType(billingType);setSelectedPrice('');}} locale={locale} billingType={billingType} preview annualDiscount={discount}/>
    {resumePending&&<div className="billing-recovery">
      {pendingConflict&&<p className="billing-status" role="status">{buttonCopy.pending}</p>}
      <p>{offerLabel(pending,locale)}</p>
      <CheckoutButton priceId={pending.id} accountHref={accountHref} label={checkoutCopy.resume??benefits.subscribe(pending.name)} copy={isOneTimePrice(pending)?prepaidButtonCopy:buttonCopy} showDisclosure={false} continueAfterLogin={false}/>
    </div>}
    <div className="subscription-grid">
      <article className="subscription-card free">
        <header><p className="membership-heading">{highlights.free}</p><h2>{free.name}</h2></header>
        <div><p className="price"><PriceAmount parts={publishedAmountParts('free',locale)}/><small className="price-unit">/ {free.priceLabel}</small></p><p className="price-terms">{free.description}</p></div>
        <div className="plan-allowance"><span>{quota.free}</span><strong className="subscription-allowance">{comparison.classic.free}</strong></div>
        <div className="subscription-purchase"><a className="button secondary" data-install-extension href={downloadHref}>{free.action}<span className="ui-icon icon-arrow" aria-hidden="true"/></a><p className="trial-note">{free.note}</p></div>
        <PlanModels locale={locale} paid={false}/>
        <ul className="subscription-features">{rows.map(row=><li key={row.key} data-feature={row.key}><span>{row.label}</span><strong>{row.free}</strong></li>)}</ul>
      </article>
      {plans.map(offer=>{
        const extra=extraPagesCopy(offer,plans,locale),managed=!!billing&&membershipCheckoutBlocked(billing,offer);
        const yearlyAmount=amount(cycleOffers.find(p=>p.plan_id===offer.plan_id&&p.interval==='year')??offer,locale);
        return <article className="subscription-card paid" data-plan={offer.plan_id} data-billing-type={billingType} data-more-pages={!!extra} key={offer.id}>
        <header><p className="membership-heading">{extra?highlights.pro:highlights.plus}</p><h2>{offer.name}</h2></header>
        <div aria-live="polite"><PlanPrice locale={locale} interval={interval} offer={offer} offers={display}/>
          <noscript><p className="billing-total">{oneTime?prepaid.year:publishedPricingCopy(locale).yearly}: {oneTime?yearlyAmount:text.billed(yearlyAmount)}</p></noscript>
        </div>
        <div className="plan-allowance"><span>{oneTime?prepaid.allowance:quota.subscription}</span><strong className="subscription-allowance">{offerBenefits(offer,locale)}</strong>{extra&&<p className="plan-difference">{extra}</p>}</div>
        <div className="subscription-purchase">
        {offer.channels.length>0?<>
        {managed?<a className="button" href={accountHref}>{manageLabel(locale)} ↗</a>:<CheckoutButton priceId={offer.id} accountHref={accountHref} label={pending?.id===offer.id?checkoutCopy.resume??benefits.subscribe(offer.name):oneTime?prepaid.buy.replace('{0}',offer.name):benefits.subscribe(offer.name)} copy={oneTime?prepaidButtonCopy:buttonCopy} disabled={billing===undefined||pendingConflict}/>}
        <p className="trial-note">{!oneTime&&offer.trial_days>0&&`${trialCopy(offer.trial_days,locale)} · ${offer.trial_classic_pages===null?copy.classic:quotaPurchaseCopy(locale).pages.replace('{0}',offer.trial_classic_pages.toLocaleString(locale))}`} {renewalCopy(offer,locale)} {!oneTime&&text.cancel} {publishedPricingCopy(locale).tax}</p>
        </>:<PublishedPurchaseAvailability locale={locale} name={offer.name} interval={interval} billingType={billingType} state={error?'error':offers?'unavailable':'loading'}/>}
        </div>
        <PlanModels locale={locale} paid/>
        <ul className="subscription-features">{rows.map(row=><li key={row.key} data-feature={row.key}><span>{row.label}</span><strong>{paidComparisonValue(row,offer,locale)}</strong></li>)}</ul>
      </article>;})}
    </div>
    <PlanComparison locale={locale} plans={plans} freeName={free.name}/>
    <p className="comparison-note">{quota.rule}</p>
    <p className="comparison-note">{oneTime?prepaid.quotaRule:quota.renewal}</p>
    <p className="comparison-note">{comparison.note}</p>
    {recoverSelected&&(!resumePending||pending?.id!==selectedPrice)&&<div className="billing-recovery"><CheckoutButton priceId={selectedPrice} accountHref={accountHref} label={checkoutCopy.resume??benefits.subscribe('PLUS')} copy={prepaidButtonCopy} showDisclosure={false} continueAfterLogin={false}/></div>}
    <QuotaOffers preview locale={locale} offers={(billing?.quota_offers??quotaOffers).length?(billing?.quota_offers??quotaOffers):publishedPacks} blocked={billing===undefined} accountHref={accountHref} checkoutCopy={buttonCopy}/>
  </div>;
}
