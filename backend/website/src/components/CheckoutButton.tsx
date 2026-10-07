import { useEffect, useRef, useState } from 'react';
import { checkoutIntentKey, rememberCheckout, takeCheckout } from '../lib/checkout-intent';

export interface CheckoutCopy { busy: string; error: string; before: string; refund: string; renewal: string }
export default function CheckoutButton({ priceId, accountHref, label, copy }: {
  priceId: string; accountHref: string; label: string; copy: CheckoutCopy;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false);
  const account = `${accountHref}?price=${encodeURIComponent(priceId)}`;
  async function start(id: string, allowLogin: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      const { session, signIn, directCheckout } = await import('../lib/direct-checkout');
      if (!await session()) {
        if (!allowLogin) throw Error('LOGIN_REQUIRED');
        const path = `${accountHref.replace(/account\/$/, 'pricing/')}?price=${encodeURIComponent(id)}`;
        rememberCheckout(sessionStorage, path, id);
        try { await signIn(path); }
        catch (error) { sessionStorage.removeItem(checkoutIntentKey); throw error; }
      } else {
        const destination = await directCheckout(id);
        location.assign(destination ?? `${accountHref}?price=${encodeURIComponent(id)}`);
      }
    } catch {
      setError(copy.error);
      inFlight.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    try {
      const price = takeCheckout(sessionStorage, location.pathname + location.search);
      if (price) void start(price, false);
    } catch { /* Storage may be disabled; an explicit click still works. */ }
  }, []);
  return <>
    <a className="button" data-purchase-link href={account} aria-disabled={busy || undefined}
      onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); void start(priceId, true);
      }}>{busy ? copy.busy : label}<span className="ui-icon icon-arrow" aria-hidden="true"/></a>
    {error && <p className="billing-status" role="alert">{error}</p>}
    <p className="trial-note">{copy.before}<a className="text-link" href={accountHref.replace(/account\/$/, 'refund/')}>{copy.refund}</a>{copy.renewal}</p>
  </>;
}
