import {useEffect,useState} from 'react';
import {billingCopy,offerLabel,type BillingOffer} from '../lib/billing';
import BillingCycle,{selectedInterval,type BillingInterval} from './BillingCycle';

export default function BillingOffers({locale,accountHref}:{locale:string;accountHref:string}){
  const [offers,setOffers]=useState<BillingOffer[]>(),[error,setError]=useState(false);
  const [preferred,setPreferred]=useState<BillingInterval>('month');
  const copy=billingCopy(locale);
  useEffect(()=>{const controller=new AbortController();fetch('/v1/billing/catalog',{signal:controller.signal,cache:'no-store'}).then(async r=>{if(!r.ok)throw Error();setOffers((await r.json()).offers);}).catch(()=>{if(!controller.signal.aborted)setError(true);});return()=>controller.abort();},[]);
  if(error)return <p role="alert">{copy.error}</p>;
  if(!offers)return <p role="status">{copy.loading}</p>;
  if(!offers.length)return <p role="status">{copy.unavailable}</p>;
  const interval=selectedInterval(offers,preferred);
  return <><BillingCycle offers={offers} value={interval} onChange={setPreferred} locale={locale}/><div className="billing-offers" aria-live="polite">{offers.filter(p=>p.interval===interval).map(p=><div className="billing-offer" key={p.id}><h3>{offerLabel(p,locale)}</h3><ul className="check-list"><li>{copy.classic}</li><li>{copy.quota(p.monthly_redraw_pages)}</li></ul><p>{p.trial_days>0&&copy.trial(p.trial_days,p.trial_redraw_pages)} {copy.renew(p.interval==='year')}</p><a className="button" href={`${accountHref}?price=${encodeURIComponent(p.id)}`}>{copy.plan} ↗</a></div>)}</div></>;
}
