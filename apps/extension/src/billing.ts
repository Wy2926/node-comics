import {msg} from './i18n/runtime';

export interface BillingPrice {
  id:string;plan_id:string;plan_revision_id:string;name:string;version:number;
  currency:string;unit_amount:number;interval:'month'|'year';monthly_redraw_pages:number;trial_days:number;trial_redraw_pages:number;
}
export interface BillingOffer extends BillingPrice {channels:BillingChannel[]}
export type BillingProvider='stripe'|'creem';
export interface BillingChannel {provider:BillingProvider;binding_id:string;trial_days:number;trial_redraw_pages:number}
export const providerLabel=(provider:BillingProvider)=>provider==='creem'?'Creem':'Stripe';
export function selectedChannel(offer:BillingOffer|undefined,preferred:BillingProvider|'',pending:BillingProvider|null=null){
  return offer?.channels.find(channel=>channel.provider===(pending??preferred))??(pending?undefined:offer?.channels[0]);
}
export function hasManagedSubscription(status:string|undefined,entitlementExpiresAt:string|null|undefined,now=Date.now()){
  return !!status&&(['active','trialing','past_due','unpaid','paused','incomplete','scheduled_cancel'].includes(status)||!!entitlementExpiresAt&&Date.parse(entitlementExpiresAt)>now);
}

export function offerAmount(offer:BillingPrice,locale:string){
  const format=new Intl.NumberFormat(locale,{style:'currency',currency:offer.currency});
  // Stripe minor units differ from ISO display precision for ISK and UGX.
  const digits=['isk','ugx'].includes(offer.currency)?2:format.resolvedOptions().maximumFractionDigits??2;
  return format.format(offer.unit_amount/10**digits);
}

export interface BillingStatus {
  enabled:boolean; providers:{id:BillingProvider;label:string;environment:'test'|'live'}[];provider:BillingProvider|null; environment:'test'|'live'; trial_eligible:boolean; checkout_pending:boolean;
  offers:BillingOffer[];checkout_price:BillingOffer|null;checkout_provider:BillingProvider|null;
  entitlement_expires_at:string|null;
  subscription:null|{provider:BillingProvider;price:BillingPrice;status:string;next_billed_at:string|null;cancel_at:string|null;trial_ends_at:string|null;paid_ends_at:string|null};
}

export function paymentUrl(value:string,provider:BillingProvider,portal=false) {
  const url=new URL(value);
  const allowed=provider==='stripe'?url.hostname===(portal?'billing.stripe.com':'checkout.stripe.com'):
    provider==='creem'&&['creem.io','www.creem.io'].includes(url.hostname)&&(portal?/^\/(?:test\/)?my-orders\/login\/[^/]+/.test(url.pathname):/^\/(?:test\/)?checkout\/[^/]+/.test(url.pathname));
  if(url.protocol!=='https:'||!allowed||url.username||url.password||url.port)
    throw new Error(msg('支付链接无效，请重试。'));
  return url.href;
}
