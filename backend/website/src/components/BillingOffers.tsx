import {useEffect,useState} from 'react';
import {billingCopy,billingBenefitCopy,amount,annualSavings,offerLabel,renewalCopy,trialCopy,type BillingOffer} from '../lib/billing';
import {pricingCopy} from '../lib/pricing';
import {comparisonCopy} from '../lib/pricing-comparison';
import {publishedLite} from '../data/published-lite';
import BillingCycle,{selectedInterval,type BillingInterval} from './BillingCycle';
import PublishedLitePricing,{PublishedPurchaseAvailability} from './PublishedLitePricing';

interface Props {
  locale:string;
  accountHref:string;
  downloadHref:string;
  free:{name:string;description:string;action:string;note:string;priceLabel:string};
}

export default function BillingOffers({locale,accountHref,downloadHref,free}:Props){
  const [offers,setOffers]=useState<BillingOffer[]>(),[error,setError]=useState(false);
  const [preferred,setPreferred]=useState<BillingInterval>('month');
  const [selectedPrice,setSelectedPrice]=useState('');
  const copy=billingCopy(locale),benefits=billingBenefitCopy(locale),text=pricingCopy(locale),comparison=comparisonCopy(locale);
  useEffect(()=>{
    const controller=new AbortController();
    const timeout=setTimeout(()=>{setError(true);controller.abort();},10000);
    fetch('/v1/billing/catalog',{signal:controller.signal,cache:'no-store'}).then(async r=>{
      if(!r.ok)throw Error();
      const catalog=await r.json();
      if(!Array.isArray(catalog.offers))throw Error();
      setOffers(catalog.offers.filter((offer:BillingOffer)=>offer?.plan_id==='lite'&&offer?.channels?.length>0));
    }).catch(()=>{if(!controller.signal.aborted)setError(true);}).finally(()=>clearTimeout(timeout));
    return()=>{clearTimeout(timeout);controller.abort();};
  },[]);
  const available=error?[]:offers??[];
  const interval=selectedInterval(available,preferred);
  const matching=available.filter(p=>p.interval===interval);
  const offer=matching.find(p=>p.id===selectedPrice)??matching[0];
  const savings=offer?annualSavings(offer,available):null;
  const annual=offer?.interval==='year';
  const rows=(['reading','classic','rate','priority','early'] as const).map(key=>({
    key,label:comparison[key].label,free:comparison[key].free,
    lite:key==='rate'?comparison.rate.lite(offer?.hourly_image_limit??publishedLite.hourlyImageLimit):comparison[key].lite,
  }));
  return <div className="pricing-comparison">
    <div className="pricing-grid">
      <article className="price-card free">
        <div className="membership-heading"><span className="membership-icon" aria-hidden="true"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg></span><span>READ EVERY DAY</span></div>
        <h2>{free.name}</h2><p>{free.description}</p>
        <p className="price"><small>US$</small>0 <span>/ {free.priceLabel}</span></p>
      </article>
      <article className="price-card paid">
        <div className="membership-heading"><span className="membership-icon" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="m3 6 5 4 4-7 4 7 5-4-3 12H6L3 6Z"/><path d="M6 21h12"/></svg></span><span>{comparison.highlights}</span><b>Lite</b></div>
        <h2>{offer?.name??'Lite'}</h2><p>{benefits.description}</p>
        {offer?<>
          <BillingCycle offers={available} value={interval} onChange={value=>{setPreferred(value);setSelectedPrice('');}} locale={locale}/>
          {matching.length>1&&<div className="billing-plan-picker" role="group" aria-label={copy.plan}>{matching.map(price=><button className="billing-plan-card" type="button" key={price.id} aria-pressed={offer.id===price.id} onClick={()=>setSelectedPrice(price.id)}>{offerLabel(price,locale)}</button>)}</div>}
          <div className="billing-offers" data-billing-catalog="live" aria-live="polite"><section className="billing-offer" aria-label={offer.name}>
            <p className="price">{amount({...offer,unit_amount:annual?offer.unit_amount/12:offer.unit_amount},locale)} <span>/ {copy.month}</span></p>
            <p className="billing-total">{annual?`${text.monthly} · ${text.billed(amount(offer,locale))}`:renewalCopy(offer,locale)}</p>
            {savings&&<p className="annual-saving"><span>{text.total} <s>{amount({...offer,unit_amount:savings.regular},locale)}</s></span><strong>{text.saving(amount({...offer,unit_amount:savings.saved},locale))}</strong></p>}
          </section></div>
        </>:<PublishedLitePricing locale={locale}/>}
      </article>
    </div>
    <table className="plan-comparison">
      <thead><tr><th scope="col">{comparison.feature}</th><th scope="col">{free.name}</th><th scope="col">{offer?.name??'Lite'}</th></tr></thead>
      <tbody>{rows.map(row=><tr key={row.key} data-feature={row.key}><th scope="row">{row.label}</th><td>{row.free}</td><td><strong>{row.lite}</strong></td></tr>)}</tbody>
    </table>
    <div className="pricing-actions">
      <div className="free-action"><a className="button secondary" href={downloadHref}>{free.action} <span aria-hidden="true">↗</span></a><p className="trial-note">{free.note}</p></div>
      <div className="paid-action">{offer?<>
        <a className="button" data-purchase-link href={`${accountHref}?price=${encodeURIComponent(offer.id)}`}>{benefits.subscribe(offer.name)} <span aria-hidden="true">↗</span></a>
        <p className="trial-note">{offer.trial_days>0&&trialCopy(offer.trial_days,offer.trial_redraw_pages,locale)} {renewalCopy(offer,locale)} {text.cancel}</p>
      </>:<PublishedPurchaseAvailability locale={locale} state={error?'error':offers?'unavailable':'loading'}/>}</div>
    </div>
    <p className="comparison-note">{comparison.note}</p>
  </div>;
}
