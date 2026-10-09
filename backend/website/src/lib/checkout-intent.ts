import { accountReturnPath } from './auth-config';
import { basePath } from '../i18n/locales';
import type {BillingProvider} from './billing';

export const checkoutIntentKey = 'nc-site-checkout-intent';
export class PurchaseRetryAllowed extends Error {
  constructor(public restart:()=>void){super('BILLING_PURCHASE_RETRY_ALLOWED');}
}
// Retain only unconfirmed requests, independently for each account and quote.
// The original provider stays bound even if the quote's available channels change.
export function readPurchaseIntent(storage:Storage,scope:string,price:string){
  const slot=`nc-quota-purchase:${scope}:${price}`,raw=storage.getItem(slot);
  try{
    const value=JSON.parse(raw??'null');
    if(value?.price===price&&(value.provider==='stripe'||value.provider==='creem')&&typeof value.key==='string'&&value.key){
      return {key:value.key as string,provider:value.provider as BillingProvider,
        complete:()=>{if(storage.getItem(slot)===raw)storage.removeItem(slot);}};
    }
  }catch{/* Invalid local data cannot authorize a replay. */}
  return null;
}
export function purchaseIntent(storage:Storage,scope:string,price:string,provider:BillingProvider){
  const previous=readPurchaseIntent(storage,scope,price);
  if(previous)return previous;
  storage.setItem(`nc-quota-purchase:${scope}:${price}`,JSON.stringify({price,provider,key:crypto.randomUUID()}));
  return readPurchaseIntent(storage,scope,price)!;
}
export function rememberCheckout(storage: Storage, path: string, price: string, now = Date.now()) {
  if (accountReturnPath(path) !== path || !/^\/pricing\/\?price=[\w-]{1,36}$/.test(basePath(path))) throw Error('Invalid checkout return');
  storage.setItem(checkoutIntentKey, JSON.stringify({ path, price, created: now }));
}
// Consume before any mutation: reloads and failed responses never auto-replay a checkout.
export function takeCheckout(storage: Storage, path: string, now = Date.now()): string | undefined {
  const value = storage.getItem(checkoutIntentKey);
  if (!value) return;
  storage.removeItem(checkoutIntentKey);
  try {
    const intent = JSON.parse(value);
    if (intent.path === path && accountReturnPath(path) === path &&
        /^\/pricing\/\?price=[\w-]{1,36}$/.test(basePath(path)) &&
        typeof intent.price === 'string' && intent.price === new URLSearchParams(path.split('?')[1]).get('price') &&
        Number.isFinite(intent.created) && now >= intent.created && now - intent.created < 15 * 60 * 1000) return intent.price;
  } catch { /* Invalid or expired intentions require another explicit click. */ }
}
