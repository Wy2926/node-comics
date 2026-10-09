import {useEffect,useState} from 'react';
import {annualSavings,billingCopy,billingBenefitCopy,offerLabel,renewalCopy,trialCopy,hasManagedSubscription,manageLabel,type BillingOffer,type Billing} from '../lib/billing';
import {pricingCopy,publishedPricingCopy} from '../lib/pricing';
import {comparisonCopy,comparisonRows} from '../lib/pricing-comparison';
import {checkoutStatusCopy} from '../i18n/commerce';
import {publishedLite} from '../data/published-lite';
import BillingCycle,{type BillingInterval} from './BillingCycle';
import {offerForInterval} from '../lib/billing-cycle';
import {LitePrice,PublishedPurchaseAvailability,publishedAmount,publishedAmountParts,publishedAnnualDiscount} from './PublishedLitePricing';
import PriceAmount from './PriceAmount';
import CheckoutButton, { type CheckoutCopy } from './CheckoutButton';
import QuotaOffers from './QuotaOffers';
import FeatureInfo from './FeatureInfo';
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
  const [preferred,setPreferred]=useState<BillingInterval>('month');
  const [selectedPrice,setSelectedPrice]=useState('');
  const copy=billingCopy(locale),benefits=billingBenefitCopy(locale),text=pricingCopy(locale),comparison=comparisonCopy(locale);
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
      setOffers(catalog.offers.filter((offer:BillingOffer)=>offer?.plan_id==='lite'&&offer.interval!=='once'&&offer?.channels?.length>0));
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
  const available=pending?[pending]:(billing?.offers??(error?[]:offers??[])).filter(offer=>offer.plan_id==='lite'&&offer.interval!=='once');
  const requested=available.find(offer=>offer.id===selectedPrice);
  const interval=pending?.interval==='month'||pending?.interval==='year'?pending.interval:requested?.interval==='month'||requested?.interval==='year'?requested.interval:preferred;
  const managed=!!billing&&(hasManagedSubscription(billing.subscription?.status,billing.entitlement_expires_at)||!!billing.gift&&billing.gift.state!=='expired');
  const matching=available.filter(p=>p.interval===interval);
  const offer=offerForInterval(available,interval,selectedPrice);
  const recoverSelected=!!billing&&/^[\w-]{1,36}$/.test(selectedPrice)&&
    ![pending,...billing.offers,...billing.quota_offers??[]].some(quote=>quote?.id===selectedPrice);
  const rows=comparisonRows(locale,offer?.hourly_image_limit??publishedLite.hourlyImageLimit);
  const annual=offerForInterval(available,'year',selectedPrice);
  const discount=annual?annualSavings(annual,available)?.percent??0:available.length?0:publishedAnnualDiscount;
  return <div className="pricing-comparison">
    <BillingCycle offers={available} value={interval} onChange={value=>{setPreferred(value);setSelectedPrice('');}} locale={locale} preview disabled={!!pending} annualDiscount={discount}/>
    <table className="plan-comparison">
      <colgroup><col className="feature-column"/><col/><col/></colgroup>
      <thead><tr className="pricing-grid">
        <th scope="col" className="comparison-heading"><span>NodeLane Comics</span><h2>{comparison.feature}</h2></th>
        <th scope="col"><article className="price-card free">
        <div className="membership-heading">{comparison.reading.label}</div>
        <h2>{free.name}</h2><p>{free.description}</p>
        <p className="price"><PriceAmount parts={publishedAmountParts('free',locale)}/><small className="price-unit">/ {free.priceLabel}</small></p>
      </article></th>
      <th scope="col" className="paid-column"><article className="price-card paid">
        <div className="membership-heading">{comparison.highlights}</div>
        <h2>{offer?.name??'Lite'}</h2><p>{comparison.classic.lite}</p>
        <div aria-live="polite"><LitePrice locale={locale} interval={interval} offer={offer}/></div>
        <noscript><p className="billing-total">{publishedPricingCopy(locale).yearly}: {text.billed(publishedAmount('year',locale))}</p></noscript>
        {offer&&matching.length>1&&<div className="billing-plan-picker" role="group" aria-label={copy.plan}>{matching.map(price=><button className="billing-plan-card" type="button" key={price.id} aria-pressed={offer.id===price.id} onClick={()=>setSelectedPrice(price.id)}>{offerLabel(price,locale)}</button>)}</div>}
      </article></th>
      </tr></thead>
      <tbody>{rows.map(row=><tr key={row.key} data-feature={row.key} data-shared={row.shared}><th scope="row"><span className="feature-label">{row.label}</span>{row.detail&&<FeatureInfo label={row.label} detail={row.detail}/>}</th><td><span className="feature-value">{row.shared&&<span className="ui-icon icon-check" aria-hidden="true"/>}<span>{row.free}</span></span></td><td><span className="feature-value"><span className="ui-icon icon-check" aria-hidden="true"/>{row.shared?<span>{row.lite}</span>:<strong>{row.lite}</strong>}</span></td></tr>)}</tbody>
      <tfoot><tr className="pricing-actions">
      <td aria-hidden="true"></td>
      <td className="free-action"><a className="button secondary" data-install-extension href={downloadHref}>{free.action}<span className="ui-icon icon-arrow" aria-hidden="true"/></a><p className="trial-note">{free.note}</p></td>
      <td className="paid-action">{offer?<>
        {managed&&!pending?<a className="button" href={accountHref}>{manageLabel(locale)} ↗</a>:<CheckoutButton priceId={offer.id} accountHref={accountHref} label={pending?.id===offer.id?checkoutCopy.resume??benefits.subscribe(offer.name):benefits.subscribe(offer.name)} copy={buttonCopy} disabled={billing===undefined||!!pending&&pending.id!==offer.id}/>}
        <p className="trial-note">{offer.trial_days>0&&trialCopy(offer.trial_days,locale)} {renewalCopy(offer,locale)} {text.cancel} {publishedPricingCopy(locale).tax}</p>
      </>:<PublishedPurchaseAvailability locale={locale} state={error?'error':offers?'unavailable':'loading'}/>}</td>
      </tr></tfoot>
    </table>
    <p className="comparison-note">{comparison.note}</p>
    {recoverSelected&&<div className="billing-recovery"><CheckoutButton priceId={selectedPrice} accountHref={accountHref} label={checkoutCopy.resume??benefits.subscribe('Lite')} copy={buttonCopy} showDisclosure={false} continueAfterLogin={false}/></div>}
    <QuotaOffers locale={locale} offers={billing?.quota_offers??(error?[]:quotaOffers)} blocked={billing===undefined} accountHref={accountHref} checkoutCopy={buttonCopy}/>
  </div>;
}
