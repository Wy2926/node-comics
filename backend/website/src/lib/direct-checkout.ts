import { api,ApiError,sessionIdentity } from './auth';
import { checkoutUrl } from './auth-config';
import { hasManagedSubscription, selectedChannel, type Billing, type BillingProvider } from './billing';
import {purchaseIntent,readPurchaseIntent,PurchaseRetryAllowed} from './checkout-intent';
export { session, signIn, subscribeAuth } from './auth';
export async function checkoutStatus(){
  const identity=await sessionIdentity();
  return identity?api<Billing>('/v1/billing/status','GET',undefined,undefined,identity):null;
}

function checkoutOffer(billing:Billing,priceId:string){
  return [billing.subscription_checkout?.price,...billing.offers,...billing.quota_offers??[]].find(item=>item?.id===priceId);
}

export function checkoutSelection(billing: Billing, priceId: string) {
  if (!billing.enabled) throw Error('CHECKOUT_UNAVAILABLE');
  const offer=checkoutOffer(billing,priceId);
  if(!offer)throw Error('CHECKOUT_UNAVAILABLE');
  const pending=offer.interval==='once'?null:billing.subscription_checkout;
  // Only subscriptions have a single original checkout to resume.
  if(pending&&pending.price.id!==priceId)return null;
  if(offer.interval!=='once'&&(hasManagedSubscription(billing.subscription?.status,billing.entitlement_expires_at)||(billing.gift&&billing.gift.state!=='expired')))return null;
  const channel = selectedChannel(offer,pending?.provider);
  if ((offer.interval!=='once'&&offer.plan_id !== 'lite'&&!pending) || !channel) throw Error('CHECKOUT_UNAVAILABLE');
  return { price_id: offer.id, provider: channel.provider };
}

export async function directCheckout(priceId: string, request: typeof api = api, storage?:Storage) {
  const identity=request===api?await sessionIdentity():undefined;
  if(request===api&&!identity)throw new ApiError('LOGIN_REQUIRED',401);
  const billing=await request<Billing>('/v1/billing/status','GET',undefined,undefined,identity??undefined);
  const offer=checkoutOffer(billing,priceId);
  let intent:ReturnType<typeof readPurchaseIntent>=null;
  let selection:{price_id:string;provider:BillingProvider}|null;
  if(!offer||offer.interval==='once'){
    const local=storage??localStorage;
    const scope=(await request<{user:{id:string}}>('/v1/me','GET',undefined,undefined,identity??undefined)).user.id;
    intent=readPurchaseIntent(local,scope,priceId);
    if(!intent){
      selection=checkoutSelection(billing,priceId);
      if(!selection)throw Error('CHECKOUT_UNAVAILABLE');
      intent=purchaseIntent(local,scope,priceId,selection.provider);
    }
    // An unconfirmed request can outlive its published quote or channel. Only
    // its exact original key/provider is replayed; the server validates it.
    selection={price_id:priceId,provider:intent.provider};
  }else selection=checkoutSelection(billing,priceId);
  if (!selection){
    return billing.subscription_checkout?{pending_price_id:billing.subscription_checkout.price.id}:null;
  }
  let result:{checkout_url:string|null;provider:BillingProvider;fulfilled?:boolean};
  try{result=await request<typeof result>('/v1/billing/checkouts','POST',selection,intent?{'Idempotency-Key':intent.key}:undefined,identity??undefined);}
  catch(error){
    if(intent&&error instanceof ApiError&&error.status===409&&error.code==='BILLING_PURCHASE_RETRY_ALLOWED')throw new PurchaseRetryAllowed(intent.complete);
    throw error;
  }
  if (result.provider !== selection.provider) throw Error('CHECKOUT_UNAVAILABLE');
  if(intent&&result.fulfilled){intent.complete();return {fulfilled:true as const};}
  if(!result.checkout_url)throw Error('CHECKOUT_UNAVAILABLE');
  const destination=checkoutUrl(result.checkout_url,selection.provider);
  // Only this creation request is confirmed, not payment. A later explicit
  // purchase may create another independent order, even for the same quote.
  intent?.complete();
  return destination;
}
