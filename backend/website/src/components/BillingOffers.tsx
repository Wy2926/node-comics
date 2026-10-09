import {useEffect,useState} from 'react';
import {amount,annualSavings,billingCopy,billingBenefitCopy,offerBenefits,renewalCopy,trialCopy,hasManagedSubscription,manageLabel,type BillingOffer,type Billing} from '../lib/billing';
import {pricingCopy,publishedPricingCopy} from '../lib/pricing';
import {comparisonCopy,comparisonRows,extraPagesCopy,paidComparisonValue} from '../lib/pricing-comparison';
import {pricingHighlightsCopy} from '../i18n/pricing-highlights';
import {checkoutStatusCopy} from '../i18n/commerce';
import {publishedSubscriptions,publishedPacks} from '../data/published-plans';
import BillingCycle,{type BillingInterval} from './BillingCycle';
import {offerForInterval} from '../lib/billing-cycle';
import {PlanPrice,PublishedPurchaseAvailability,publishedAmountParts,publishedAnnualDiscount} from './PublishedPlanPricing';
import PriceAmount from './PriceAmount';
import CheckoutButton, { type CheckoutCopy } from './CheckoutButton';
import QuotaOffers from './QuotaOffers';
import PlanModels from './PlanModels';
import PlanComparison from './PlanComparison';
import {quotaPurchaseCopy} from '../i18n/quota-purchase';
import {subscriptionQuotaCopy} from '../i18n/subscription-quota';
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
  const [preferred,setPreferred]=useState<BillingInterval>('quarter');
  const [selectedPrice,setSelectedPrice]=useState('');
  const copy=billingCopy(locale),benefits=billingBenefitCopy(locale),text=pricingCopy(locale),comparison=comparisonCopy(locale);
  const quota=subscriptionQuotaCopy(locale);
  const highlights=pricingHighlightsCopy(locale);
  const buttonCopy={...checkoutCopy,...checkoutStatusCopy(locale)};
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
  const pending=billing?.subscription_checkout?.price;
  const available=pending?[pending]:(billing?.offers??(error?[]:offers??[])).filter(offer=>offer.interval!=='once');
  const requested=available.find(offer=>offer.id===selectedPrice);
  const interval=pending?.interval==='month'||pending?.interval==='quarter'||pending?.interval==='year'?pending.interval:requested?.interval==='month'||requested?.interval==='quarter'||requested?.interval==='year'?requested.interval:preferred;
  const managed=!!billing&&(hasManagedSubscription(billing.subscription?.status,billing.entitlement_expires_at)||!!billing.gift&&billing.gift.state!=='expired');
  const display=available.some(offer=>offer.interval===interval)?available:publishedSubscriptions;
  const plans=[...new Set(display.map(offer=>offer.plan_id))].map(plan=>
    offerForInterval(display.filter(offer=>offer.plan_id===plan),interval,selectedPrice)).filter((offer):offer is BillingOffer=>!!offer);
  const recoverSelected=!!billing&&/^[\w-]{1,36}$/.test(selectedPrice)&&
    ![pending,...billing.offers,...billing.quota_offers??[]].some(quote=>quote?.id===selectedPrice);
  const rows=comparisonRows(locale,0).filter(row=>row.key==='rate'||row.key==='priority');
  const annual=offerForInterval(available,'year',selectedPrice);
  const discount=annual?annualSavings(annual,available)?.percent??0:available.length?0:publishedAnnualDiscount;
  return <div className="pricing-comparison">
    <BillingCycle offers={available.length?available:publishedSubscriptions} value={interval} onChange={value=>{setPreferred(value);setSelectedPrice('');}} locale={locale} preview disabled={!!pending} annualDiscount={discount}/>
    <div className="subscription-grid">
      <article className="subscription-card free">
        <header><p className="membership-heading">{highlights.free}</p><h2>{free.name}</h2></header>
        <div><p className="price"><PriceAmount parts={publishedAmountParts('free',locale)}/><small className="price-unit">/ {free.priceLabel}</small></p><p className="price-terms">{free.description}</p></div>
        <div className="plan-allowance"><span>{quota.free}</span><strong className="subscription-allowance">{comparison.classic.free}</strong></div>
        <div className="subscription-purchase"><a className="button secondary" data-install-extension href={downloadHref}>{free.action}<span className="ui-icon icon-arrow" aria-hidden="true"/></a><p className="trial-note">{free.note}</p></div>
        <PlanModels locale={locale} paid={false}/>
        <ul className="subscription-features">{rows.map(row=><li key={row.key} data-feature={row.key}><span>{row.label}</span><strong>{row.free}</strong></li>)}</ul>
      </article>
      {plans.map(offer=>{const extra=extraPagesCopy(offer,plans,locale);return <article className="subscription-card paid" data-plan={offer.plan_id} data-more-pages={!!extra} key={offer.id}>
        <header><p className="membership-heading">{extra?highlights.pro:highlights.plus}</p><h2>{offer.name}</h2></header>
        <div aria-live="polite"><PlanPrice locale={locale} interval={interval} offer={offer} offers={display}/>
          <noscript><p className="billing-total">{publishedPricingCopy(locale).yearly}: {text.billed(amount((available.length?available:publishedSubscriptions).find(p=>p.plan_id===offer.plan_id&&p.interval==='year')??offer,locale))}</p></noscript>
        </div>
        <div className="plan-allowance"><span>{quota.subscription}</span><strong className="subscription-allowance">{offerBenefits(offer,locale)}</strong>{extra&&<p className="plan-difference">{extra}</p>}</div>
        <div className="subscription-purchase">
        {offer.channels.length>0?<>
        {managed&&!pending?<a className="button" href={accountHref}>{manageLabel(locale)} ↗</a>:<CheckoutButton priceId={offer.id} accountHref={accountHref} label={pending?.id===offer.id?checkoutCopy.resume??benefits.subscribe(offer.name):benefits.subscribe(offer.name)} copy={buttonCopy} disabled={billing===undefined||!!pending&&pending.id!==offer.id}/>}
        <p className="trial-note">{offer.trial_days>0&&`${trialCopy(offer.trial_days,locale)} · ${offer.trial_classic_pages===null?copy.classic:quotaPurchaseCopy(locale).pages.replace('{0}',offer.trial_classic_pages.toLocaleString(locale))}`} {renewalCopy(offer,locale)} {text.cancel} {publishedPricingCopy(locale).tax}</p>
        </>:<PublishedPurchaseAvailability locale={locale} name={offer.name} interval={interval} state={error?'error':offers?'unavailable':'loading'}/>}
        </div>
        <PlanModels locale={locale} paid/>
        <ul className="subscription-features">{rows.map(row=><li key={row.key} data-feature={row.key}><span>{row.label}</span><strong>{paidComparisonValue(row,offer,locale)}</strong></li>)}</ul>
      </article>;})}
    </div>
    <PlanComparison locale={locale} plans={plans} freeName={free.name}/>
    <p className="comparison-note">{quota.rule}</p>
    <p className="comparison-note">{quota.renewal}</p>
    <p className="comparison-note">{comparison.note}</p>
    {recoverSelected&&<div className="billing-recovery"><CheckoutButton priceId={selectedPrice} accountHref={accountHref} label={checkoutCopy.resume??benefits.subscribe('PLUS')} copy={buttonCopy} showDisclosure={false} continueAfterLogin={false}/></div>}
    <QuotaOffers preview locale={locale} offers={(billing?.quota_offers??quotaOffers).length?(billing?.quota_offers??quotaOffers):publishedPacks} blocked={billing===undefined} accountHref={accountHref} checkoutCopy={buttonCopy}/>
  </div>;
}
