import {msg} from './i18n/runtime';

export interface BillingStatus {
  enabled:boolean; provider:'stripe'; environment:'test'|'live'; trial_eligible:boolean; checkout_pending:boolean;
  subscription:null|{status:string;next_billed_at:string|null;cancel_at:string|null;trial_ends_at:string|null;paid_ends_at:string|null};
}

export function stripeUrl(value:string,portal=false) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!==(portal?'billing.stripe.com':'checkout.stripe.com')||url.username||url.password||url.port)
    throw new Error(msg('支付链接无效，请重试。'));
  return url.href;
}
