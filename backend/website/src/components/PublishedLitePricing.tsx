import {publishedLite} from '../data/published-lite';
import {amount,amountParts,annualSavingsForAmounts,billingCopy,billingBenefitCopy,trialCopy,type BillingOffer} from '../lib/billing';
import type {BillingInterval} from '../lib/billing-cycle';
import {pricingCopy,publishedPricingCopy} from '../lib/pricing';
import PriceAmount from './PriceAmount';

export type PurchaseAvailability='loading'|'unavailable'|'error';
export const publishedAnnualDiscount=annualSavingsForAmounts(Number(publishedLite.monthlyAmount),Number(publishedLite.yearlyAmount))?.percent??0;
export function publishedAmountParts(interval:BillingInterval|'free',locale:string,monthlyEquivalent=false):Intl.NumberFormatPart[]{
  const value=interval==='free'?0:Number(interval==='year'?publishedLite.yearlyAmount:publishedLite.monthlyAmount);
  const digits=interval==='free'?0:2;
  return [{type:'currency',value:'US$'},...new Intl.NumberFormat(locale,{minimumFractionDigits:digits,maximumFractionDigits:digits}).formatToParts(monthlyEquivalent&&interval==='year'?value/12:value)];
}
export function publishedAmount(interval:BillingInterval,locale:string,monthlyEquivalent=false){
  return publishedAmountParts(interval,locale,monthlyEquivalent).map(part=>part.value).join('');
}

// The large figure always means the actual amount charged for the selected period.
// Published numbers never acquire an API price ID or enable a checkout action.
export function LitePrice({locale,interval,offer}:{locale:string;interval:BillingInterval;offer?:BillingOffer}){
  const copy=billingCopy(locale),text=pricingCopy(locale),published=publishedPricingCopy(locale);
  const annual=interval==='year';
  const total=offer?amount(offer,locale):publishedAmount(interval,locale);
  const monthly=annual?(offer?amount({...offer,unit_amount:offer.unit_amount/12},locale):publishedAmount(interval,locale,true)):null;
  return <div className={offer?'billing-offer':'published-lite-pricing'} data-billing-catalog={offer?'live':'published'} data-billing-interval={interval}>
    <p className="price"><PriceAmount parts={offer?amountParts(offer,locale):publishedAmountParts(interval,locale)}/><small className="price-unit">/ {annual?copy.year:copy.month}</small></p>
    <div className="price-terms">
      <p className="billing-total">{annual?text.billed(total):copy.renew(false)}</p>
      {monthly&&<p className="monthly-equivalent">{text.monthly}: {monthly} / {copy.month}</p>}
      {!offer&&<p className="published-pricing-label">{published.label}</p>}
    </div>
  </div>;
}

export default function PublishedLitePricing({locale,interval='month'}:{locale:string;interval?:BillingInterval}){
  return <LitePrice locale={locale} interval={interval}/>;
}

export function PublishedPurchaseAvailability({locale,state}:{locale:string;state:PurchaseAvailability}){
  const published=publishedPricingCopy(locale);
  return <div className="billing-availability" data-state={state}>
    <button className="button" type="button" disabled>{billingBenefitCopy(locale).subscribe('Lite')}</button>
    <p className="billing-status" role={state==='error'?'alert':'status'}>{published[state]}</p>
    <p className="trial-note">{trialCopy(publishedLite.trialDays,locale)} {published.tax}</p>
  </div>;
}
