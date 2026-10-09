import type {BillingOffer} from './billing';

export type BillingInterval='month'|'year';

// Account checkout stays on a purchasable cadence. Public price browsing does not
// use this fallback: a missing quote must never change the visitor's selection.
export function selectedInterval(offers:BillingOffer[],preferred:BillingInterval):BillingInterval{
  if(offers.some(offer=>offer.interval===preferred))return preferred;
  const first=offers.find(offer=>offer.interval==='month'||offer.interval==='year');
  return first?.interval==='year'?'year':first?.interval==='month'?'month':preferred;
}

export function offerForInterval(offers:BillingOffer[],interval:BillingInterval,selectedPrice=''){
  return offers.find(offer=>offer.interval===interval&&offer.id===selectedPrice)
    ??offers.find(offer=>offer.interval===interval);
}
