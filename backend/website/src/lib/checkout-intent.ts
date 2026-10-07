import { accountReturnPath } from './auth-config';
import { basePath } from '../i18n/locales';

export const checkoutIntentKey = 'nc-site-checkout-intent';
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
