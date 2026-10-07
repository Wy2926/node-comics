import type {BillingOffer} from './billing';

export type BillingInterval='month'|'year';

// Account checkout stays on a purchasable cadence. Public price browsing does not
// use this fallback: a missing quote must never change the visitor's selection.
export function selectedInterval(offers:BillingOffer[],preferred:BillingInterval):BillingInterval{
  return offers.some(offer=>offer.interval===preferred)?preferred:offers[0]?.interval??preferred;
}

export function offerForInterval(offers:BillingOffer[],interval:BillingInterval,selectedPrice=''){
  return offers.find(offer=>offer.interval===interval&&offer.id===selectedPrice)
    ??offers.find(offer=>offer.interval===interval);
}
