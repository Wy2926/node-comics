import {msg} from './i18n/runtime';

export interface BillingOffer {
  id:string;plan_id:string;plan_revision_id:string;name:string;version:number;
  currency:string;unit_amount:number;interval:'month'|'year';monthly_redraw_pages:number;trial_days:number;trial_redraw_pages:number;
}

export function offerAmount(offer:BillingOffer,locale:string){
  const format=new Intl.NumberFormat(locale,{style:'currency',currency:offer.currency});
  // Stripe minor units differ from ISO display precision for ISK and UGX.
  const digits=['isk','ugx'].includes(offer.currency)?2:format.resolvedOptions().maximumFractionDigits??2;
  return format.format(offer.unit_amount/10**digits);
}

export interface BillingStatus {
  enabled:boolean; provider:'stripe'; environment:'test'|'live'; trial_eligible:boolean; checkout_pending:boolean;
  offers:BillingOffer[];checkout_price:BillingOffer|null;
  subscription:null|{price:BillingOffer;status:string;next_billed_at:string|null;cancel_at:string|null;trial_ends_at:string|null;paid_ends_at:string|null};
}

export function stripeUrl(value:string,portal=false) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!==(portal?'billing.stripe.com':'checkout.stripe.com')||url.username||url.password||url.port)
    throw new Error(msg('支付链接无效，请重试。'));
  return url.href;
}
