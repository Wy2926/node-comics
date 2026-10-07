import { api } from './auth';
import { checkoutUrl } from './auth-config';
import { hasManagedSubscription, selectedChannel, type Billing, type BillingProvider } from './billing';
export { session, signIn } from './auth';

export function checkoutSelection(billing: Billing, priceId: string) {
  if (!billing.enabled) throw Error('CHECKOUT_UNAVAILABLE');
  // Existing obligations and a different pending quote need account management,
  // never a silent switch to another price, interval or payment provider.
  if (hasManagedSubscription(billing.subscription?.status, billing.entitlement_expires_at) ||
      (billing.gift && billing.gift.state !== 'expired') ||
      (billing.checkout_pending && billing.checkout_price?.id !== priceId)) return null;
  const offer = billing.checkout_pending ? billing.checkout_price : billing.offers.find(item => item.id === priceId);
  const channel = selectedChannel(offer ?? undefined, '', billing.checkout_pending ? billing.checkout_provider : null);
  if (!offer || offer.plan_id !== 'lite' || !channel) throw Error('CHECKOUT_UNAVAILABLE');
  return { price_id: offer.id, provider: channel.provider };
}

export async function directCheckout(priceId: string, request: typeof api = api) {
  const selection = checkoutSelection(await request<Billing>('/v1/billing/status'), priceId);
  if (!selection) return null;
  const result = await request<{ checkout_url: string; provider: BillingProvider }>('/v1/billing/checkouts', 'POST', selection);
  if (result.provider !== selection.provider) throw Error('CHECKOUT_UNAVAILABLE');
  return checkoutUrl(result.checkout_url, selection.provider);
}
