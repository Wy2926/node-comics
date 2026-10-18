import {isOneTimePrice,type BillingOffer,type BillingType} from './billing';

export type BillingInterval='month'|'quarter'|'year';

// Explicit quotes win; changing language must not replace an unpaid membership's payment type.
export function membershipBillingType(locale:string,requested?:BillingOffer,pending?:BillingOffer):BillingType{
  const quote=[requested,pending].find(offer=>offer&&offer.interval!=='once');
  return quote?(isOneTimePrice(quote)?'onetime':'recurring'):locale==='zh-CN'?'onetime':'recurring';
}

export function offerForInterval(offers:BillingOffer[],interval:BillingInterval,selectedPrice=''){
  return offers.find(offer=>offer.interval===interval&&offer.id===selectedPrice)
    ??offers.find(offer=>offer.interval===interval);
}

export function membershipPricing(quotes:BillingOffer[],published:BillingOffer[],interval:BillingInterval,billingType:BillingType,selectedPrice=''){
  const oneTime=billingType==='onetime';
  const available=quotes.filter(offer=>isOneTimePrice(offer)===oneTime);
  const fallback=published.filter(offer=>!oneTime||offer.interval!=='month').map(offer=>({...offer,billing_type:billingType}));
  // Missing quotes stay display-only; neither cadence nor payment type may change.
  const display=available.some(offer=>offer.interval===interval)?available:fallback;
  const plans=[...new Set(display.map(offer=>offer.plan_id))].map(plan=>
    offerForInterval(display.filter(offer=>offer.plan_id===plan),interval,selectedPrice)).filter((offer):offer is BillingOffer=>!!offer);
  return {available,display,plans,cycleOffers:available.length?available:fallback};
}
