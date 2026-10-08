import { mobilePlatforms } from '../data/mobile';

export type StoreBrowser = 'chrome' | 'edge' | 'firefox';

interface BrowserIdentity {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean; brands?: readonly { brand: string }[] };
}

// Only desktop browsers can link straight to a store. Mobile guides are resolved
// separately; unknown browsers retain the localized download chooser.
export function desktopBrowser(identity: BrowserIdentity): StoreBrowser | undefined {
  const { userAgent: ua, userAgentData: hints } = identity;
  if (hints?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
      identity.platform === 'MacIntel' && (identity.maxTouchPoints ?? 0) > 1) return;
  const brands = hints?.brands?.map(item => item.brand) ?? [];
  if (brands.includes('Microsoft Edge') || /Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/OPR\/|Opera|Vivaldi|SamsungBrowser\/|Electron\/|HeadlessChrome\//i.test(ua)) return;
  if (brands.length) return brands.includes('Google Chrome') ? 'chrome' : undefined;
  if (/Chrome\//.test(ua)) return 'chrome';
}

export function browserStoreUrl(identity: BrowserIdentity, stores: Record<StoreBrowser, string>) {
  const browser = desktopBrowser(identity);
  return browser ? stores[browser] || undefined : undefined;
}

// A mobile installation action always opens instructions, never an app package.
export function mobileGuidePath(identity: BrowserIdentity): string | undefined {
  const { userAgent, platform, maxTouchPoints = 0 } = identity;
  const id = /Android/i.test(userAgent) ? 'android'
    : /iPhone|iPad|iPod/i.test(userAgent) || platform === 'MacIntel' && maxTouchPoints > 1 ? 'ios' : undefined;
  const guide = mobilePlatforms.find(item => item.id === id);
  return guide ? `/guides/${guide.slug}/` : undefined;
}
