import {publishedSubscriptions} from '../data/published-plans';
import {amount,amountParts,annualSavings,billingCopy,billingBenefitCopy,renewalCopy,type BillingOffer} from '../lib/billing';
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
export function PlanPrice({locale,interval,offer}:{locale:string;interval:BillingInterval;offer?:BillingOffer}){
  const copy=billingCopy(locale),text=pricingCopy(locale),published=publishedPricingCopy(locale);
  const annual=interval==='year',quarter=interval==='quarter',live=!!offer&&offer.channels?.length!==0;
  const parts=live?amountParts(offer!,locale):publishedAmountParts(interval,locale,false,offer?.unit_amount);
  const total=parts.map(part=>part.value).join('');
  const months=annual?12:quarter?3:1;
  const monthly=months>1?(live?amount({...offer!,unit_amount:offer!.unit_amount/months},locale):publishedAmountParts(interval,locale,true,offer?.unit_amount).map(part=>part.value).join('')):null;
  return <div className={live?'billing-offer':'published-plan-pricing'} data-billing-catalog={live?'live':'published'} data-billing-interval={interval}>
    <p className="price"><PriceAmount parts={parts}/><small className="price-unit">/ {quarter?quarterlyCopy(locale).unit:annual?copy.year:copy.month}</small></p>
    <div className="price-terms">
      <p className="billing-total">{annual?text.billed(total):renewalCopy({interval},locale)}</p>
      {monthly&&<p className="monthly-equivalent">{text.monthly}: {monthly} / {copy.month}</p>}
      {!live&&<p className="published-pricing-label">{published.label}</p>}
    </div>
  </div>;
}

export default function PublishedPlanPricing({locale,interval='quarter'}:{locale:string;interval?:BillingInterval}){
  return <PlanPrice locale={locale} interval={interval}/>;
}

export function PublishedPurchaseAvailability({locale,state,name='PLUS'}:{locale:string;state:PurchaseAvailability;name?:string}){
  const published=publishedPricingCopy(locale);
  return <div className="billing-availability" data-state={state}>
    <button className="button" type="button" disabled>{billingBenefitCopy(locale).subscribe(name)}</button>
    <p className="billing-status" role={state==='error'?'alert':'status'}>{published[state]}</p>
    <p className="trial-note">{published.tax}</p>
  </div>;
}
