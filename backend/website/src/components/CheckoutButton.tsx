import { useEffect, useRef, useState } from 'react';
import { checkoutIntentKey, rememberCheckout, takeCheckout,PurchaseRetryAllowed } from '../lib/checkout-intent';
import { ApiError } from '../lib/auth-session';

export interface CheckoutCopy { busy: string; error: string; before: string; refund: string; renewal: string;retry?:string;retryHint?:string;resume?:string;uncertain?:string;conflict?:string }
export default function CheckoutButton({ priceId, accountHref, label, copy,disabled=false,showDisclosure=true,continueAfterLogin=true }: {
  priceId: string; accountHref: string; label: string; copy: CheckoutCopy;disabled?:boolean;showDisclosure?:boolean;continueAfterLogin?:boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false);
  const epoch=useRef(0);
  const [restartPurchase,setRestartPurchase]=useState<(()=>void)|null>(null);
  const pricing=accountHref.replace(/account\/$/,'pricing/');
  const destination = `${pricing}?price=${encodeURIComponent(priceId)}`;
  async function start(id: string, allowLogin: boolean) {
    if (inFlight.current) return;
    const current=++epoch.current;
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      if(restartPurchase){restartPurchase();setRestartPurchase(null);}
      const { session, signIn, directCheckout } = await import('../lib/direct-checkout');
      const signedIn=await session();
      if(current!==epoch.current)return;
      if (!signedIn) {
        if (!allowLogin) throw Error('LOGIN_REQUIRED');
        const path = `${accountHref.replace(/account\/$/, 'pricing/')}?price=${encodeURIComponent(id)}`;
        rememberCheckout(sessionStorage, path, id);
        try { await signIn(path); }
        catch (error) { sessionStorage.removeItem(checkoutIntentKey); throw error; }
      } else {
        const destination = await directCheckout(id);
        if(current!==epoch.current)return;
        location.assign(typeof destination==='string'?destination:accountHref);
      }
    } catch(error) {
      if(current!==epoch.current)return;
      if(error instanceof PurchaseRetryAllowed){setRestartPurchase(()=>error.restart);setError(copy.retryHint??copy.error);}
      else if(error instanceof ApiError&&(error.code==='CREEM_CHECKOUT_UNCERTAIN'||error.code==='BILLING_CHECKOUT_UNCERTAIN'))setError(copy.uncertain??copy.error);
      else if(error instanceof ApiError&&error.code==='BILLING_CHECKOUT_PRICE_CONFLICT')setError(copy.conflict??copy.error);
      else setError(copy.error);
      inFlight.current = false;
      setBusy(false);
    }
  }
  useEffect(()=>{
    let disposed=false,unsubscribe:(()=>void)|undefined;
    const returned=(event:PageTransitionEvent)=>{
      if(event.persisted){epoch.current++;inFlight.current=false;setBusy(false);}
    };
    window.addEventListener('pageshow',returned);
    void import('../lib/direct-checkout').then(({subscribeAuth})=>{
      if(disposed)return;
      unsubscribe=subscribeAuth(()=>{epoch.current++;inFlight.current=false;setBusy(false);setError('');setRestartPurchase(null);});
    }).catch(()=>{/* The explicit purchase action reports an unavailable module. */});
    return()=>{disposed=true;epoch.current++;unsubscribe?.();window.removeEventListener('pageshow',returned);};
  },[]);
  useEffect(() => {
    try {
      if(disabled)return;
      if(new URLSearchParams(location.search).get('price')!==priceId)return;
      const price = takeCheckout(sessionStorage, location.pathname + location.search);
      if (price&&continueAfterLogin) void start(price, false);
    } catch { /* Storage may be disabled; an explicit click still works. */ }
  }, [priceId,disabled,continueAfterLogin]);
  return <>
    <a className="button" data-purchase-link href={destination} aria-disabled={busy || disabled || undefined}
      onClick={event => {
        if(disabled){event.preventDefault();return;}
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); void start(priceId, true);
      }}>{busy ? copy.busy : restartPurchase?copy.retry??label:label}<span className="ui-icon icon-arrow" aria-hidden="true"/></a>
    {error && <p className="billing-status" role="alert">{error}</p>}
    {showDisclosure&&<p className="trial-note">{copy.before}<a className="text-link" href={accountHref.replace(/account\/$/, 'refund/')}>{copy.refund}</a>{copy.renewal}</p>}
  </>;
}
