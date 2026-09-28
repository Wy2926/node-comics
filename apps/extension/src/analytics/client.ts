import { getLocale } from '../i18n/runtime';
import { sanitizeEvent, type AnalyticsEventName, type AnalyticsParams } from './schema';
import type { AnalyticsPreferences } from './prompt';

export const analyticsAvailable = () => typeof chrome !== 'undefined' && !!chrome.runtime?.id && chrome.extension?.inIncognitoContext !== true;

/** Telemetry cannot delay or fail a product operation. Web previews never transmit. */
export function track<N extends AnalyticsEventName>(name: N, params: AnalyticsParams<N> = {}, startedAt = Date.now(), navigationId?: string): void {
  try {
    if (!analyticsAvailable() || !Number.isSafeInteger(startedAt) || startedAt < 0)
      return;
    const event = sanitizeEvent(name, { ...params, ui_language: getLocale() });
    if (!event)
      return;
    const pending = chrome.runtime.sendMessage({ type: 'NC_ANALYTICS_TRACK', ...event, startedAt, ...(navigationId ? {navigationId} : {}) });
    void pending.catch(() => {});
  } catch {
    // Optional diagnostics must never affect reading.
  }
}

export async function readAnalyticsPreferences(navigationId?: string): Promise<AnalyticsPreferences> {
  if (!analyticsAvailable())
    return { enabled: false, promptHandled: true };
  const result = await chrome.runtime.sendMessage({ type: 'NC_ANALYTICS_STATUS', ...(navigationId ? {navigationId} : {}) });
  if (result?.ok !== true)
    throw Error('ANALYTICS_CONSENT_UNAVAILABLE');
  const consentedAt = result.consentedAt;
  return {
    enabled: result.enabled === true,
    promptHandled: result.promptHandled === true,
    ...(result.enabled === true && Number.isSafeInteger(consentedAt) && consentedAt >= 0 ? {consentedAt: consentedAt as number} : {}),
  };
}

export async function saveAnalyticsConsent(enabled: boolean): Promise<boolean> {
  if (!analyticsAvailable())
    return false;
  const result = await chrome.runtime.sendMessage({ type: 'NC_ANALYTICS_CONSENT', enabled });
  if (result?.ok !== true)
    throw Error('ANALYTICS_CONSENT_UNAVAILABLE');
  return result.enabled === true;
}
