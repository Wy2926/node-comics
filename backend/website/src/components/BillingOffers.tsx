import {useEffect,useState} from 'react';
import {billingCopy,amount,annualSavings,type BillingOffer} from '../lib/billing';
import {pricingCopy} from '../lib/pricing';
import BillingCycle,{selectedInterval,type BillingInterval} from './BillingCycle';

export default function BillingOffers({locale,accountHref,benefits}:{locale:string;accountHref:string;benefits:string[]}){
  const [offers,setOffers]=useState<BillingOffer[]>(),[error,setError]=useState(false);
  const [preferred,setPreferred]=useState<BillingInterval>('month');
  const copy=billingCopy(locale),text=pricingCopy(locale);
  useEffect(()=>{const controller=new AbortController();fetch('/v1/billing/catalog',{signal:controller.signal,cache:'no-store'}).then(async r=>{if(!r.ok)throw Error();setOffers((await r.json()).offers);}).catch(()=>{if(!controller.signal.aborted)setError(true);});return()=>controller.abort();},[]);
  if(error)return <p className="billing-status" role="alert">{copy.error}</p>;
  if(!offers)return <p className="billing-status" role="status">{copy.loading}</p>;
  if(!offers.length)return <p className="billing-status" role="status">{copy.unavailable}</p>;
  const interval=selectedInterval(offers,preferred);
  return <><BillingCycle offers={offers} value={interval} onChange={setPreferred} locale={locale}/><div className="billing-offers" aria-live="polite">{offers.filter(p=>p.interval===interval).map(p=>{
    const savings=annualSavings(p,offers),annual=p.interval==='year';
    return <section className="billing-offer" key={p.id} aria-label={p.name}>
      {p.name!=='PLUS'&&<h3 className="offer-heading">{p.name}</h3>}
      <p className="price">{amount({...p,unit_amount:annual?p.unit_amount/12:p.unit_amount},locale)} <span>/ {copy.month}</span></p>
      <p className="billing-total">{annual?`${text.monthly} · ${text.billed(amount(p,locale))}`:copy.renew(false)}</p>
      {savings&&<p className="annual-saving"><span>{text.total} <s>{amount({...p,unit_amount:savings.regular},locale)}</s></span><strong>{text.saving(amount({...p,unit_amount:savings.saved},locale))}</strong></p>}
      <div className="membership-rights"><div><span>{text.classic}</span><strong>{text.unlimited}</strong></div><div><span>{text.redraw}</span><strong>{p.monthly_redraw_pages.toLocaleString(locale)} <small>{text.pages}</small></strong></div></div>
      <ul className="check-list">{benefits.map(item=><li key={item}>{item}</li>)}</ul>
      <p className="membership-terms">{text.quota}</p>
      <a className="button" href={`${accountHref}?price=${encodeURIComponent(p.id)}`}>{text.subscribe} <span aria-hidden="true">↗</span></a>
      <p className="trial-note">{p.trial_days>0&&text.trial(p.trial_days,p.trial_redraw_pages)} {copy.renew(annual)} {text.cancel}</p>
    </section>;
  })}</div></>;
}
