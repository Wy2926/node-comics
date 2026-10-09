import {publishedSubscriptions} from '../data/published-plans';
import {amountParts,annualSavings,billingCopy,billingBenefitCopy,renewalCopy,type BillingOffer} from '../lib/billing';
import type {BillingInterval} from '../lib/billing-cycle';
import {pricingCopy,publishedPricingCopy} from '../lib/pricing';
import {quarterlyCopy} from '../i18n/billing-cadence';
import PriceAmount from './PriceAmount';

export type PurchaseAvailability='loading'|'unavailable'|'error';
export const publishedAnnualDiscount=annualSavings(publishedSubscriptions.find(offer=>offer.plan_id==='plus'&&offer.interval==='year')!,publishedSubscriptions)?.percent??0;
export function publishedAmountParts(interval:BillingInterval|'free',locale:string,monthlyEquivalent=false,unitAmount?:number):Intl.NumberFormatPart[]{
  const value=interval==='free'?0:(unitAmount??publishedSubscriptions.find(offer=>offer.plan_id==='plus'&&offer.interval===interval)?.unit_amount??0)/100;
  const digits=interval==='free'?0:2;
  return [{type:'currency',value:'US$'},...new Intl.NumberFormat(locale,{minimumFractionDigits:digits,maximumFractionDigits:digits}).formatToParts(monthlyEquivalent?value/(interval==='year'?12:interval==='quarter'?3:1):value)];
}
export function publishedAmount(interval:BillingInterval,locale:string,monthlyEquivalent=false){
  return publishedAmountParts(interval,locale,monthlyEquivalent).map(part=>part.value).join('');
}

// The large figure always means the actual amount charged for the selected period.
// Published numbers never acquire an API price ID or enable a checkout action.
export function PlanPrice({locale,interval,offer,offers}:{locale:string;interval:BillingInterval;offer?:BillingOffer;offers?:BillingOffer[]}){
  const copy=billingCopy(locale),text=pricingCopy(locale);
  const annual=interval==='year',quarter=interval==='quarter',live=!!offer&&offer.channels?.length!==0;
  const parts=live?amountParts(offer!,locale):publishedAmountParts(interval,locale,false,offer?.unit_amount);
  const months=annual?12:quarter?3:1;
  const monthly=months>1?(live?amountParts({...offer!,unit_amount:offer!.unit_amount/months},locale):publishedAmountParts(interval,locale,true,offer?.unit_amount)):null;
  const quote=offer??publishedSubscriptions.find(item=>item.plan_id==='plus'&&item.interval===interval);
  const savings=quote?annualSavings(quote,offers??(live?[]:publishedSubscriptions)):null;
  return <div className={live?'billing-offer':'published-plan-pricing'} data-billing-catalog={live?'live':'published'} data-billing-interval={interval}>
    <p className="price"><PriceAmount parts={parts}/><small className="price-unit">/ {quarter?quarterlyCopy(locale).unit:annual?copy.year:copy.month}</small></p>
    <div className="price-terms">
      {monthly&&<div className="monthly-equivalent">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18M8 15h3M8 18h7"/></svg>
        <span>{text.monthly}<strong><PriceAmount parts={monthly}/><small> / {copy.month}</small></strong></span>
      </div>}
      {savings&&<p className="price-discount">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7.5" cy="7.5" r="1"/><path d="m11 16 5-5"/></svg>
        <span>{text.save(savings.percent)}</span>
      </p>}
    </div>
  </div>;
}

export default function PublishedPlanPricing({locale,interval='quarter'}:{locale:string;interval?:BillingInterval}){
  return <PlanPrice locale={locale} interval={interval}/>;
}

export function PublishedPurchaseAvailability({locale,state,name='PLUS',interval='quarter'}:{locale:string;state:PurchaseAvailability;name?:string;interval?:BillingInterval}){
  const published=publishedPricingCopy(locale);
  return <div className="billing-availability" data-state={state}>
    <button className="button" type="button" disabled>{billingBenefitCopy(locale).subscribe(name)}</button>
    <p className="billing-status" role={state==='error'?'alert':'status'}>{published[state]}</p>
    <p className="trial-note">{renewalCopy({interval},locale)} {pricingCopy(locale).cancel} {published.tax}</p>
  </div>;
}
