import {useSyncExternalStore} from 'react';
import {analyticsAvailable, readAnalyticsPreferences} from './client';
import {analyticsStorageKey} from './engine';
import {analyticsPromptStorageKey, type AnalyticsPreferences} from './prompt';

interface Snapshot extends AnalyticsPreferences {ready: boolean;}
const initial: Snapshot = {ready: false, enabled: false, promptHandled: true};
let snapshot = initial;
let watching = false;
let request = 0;
const listeners = new Set<() => void>();

function publish(value: Snapshot) {
  if (snapshot.ready === value.ready && snapshot.enabled === value.enabled && snapshot.promptHandled === value.promptHandled && snapshot.consentedAt === value.consentedAt) return;
  snapshot = value;
  for (const listener of listeners) listener();
}

export async function refreshAnalyticsPreferences() {
  const current = ++request;
  try {
    const value = await readAnalyticsPreferences();
    if (current === request) publish({...value, ready: true});
  } catch {
    if (current === request) publish(initial);
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!watching && analyticsAvailable()) {
    watching = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      const change = changes[analyticsStorageKey];
      const oldConsent = (change?.oldValue as {consent?: boolean} | undefined)?.consent;
      const nextConsent = (change?.newValue as {consent?: boolean} | undefined)?.consent;
      const oldEpoch = (change?.oldValue as {consented_at?: number} | undefined)?.consented_at;
      const nextEpoch = (change?.newValue as {consented_at?: number} | undefined)?.consented_at;
      if (area === 'local' && (changes[analyticsPromptStorageKey] || change && (oldConsent !== nextConsent || oldEpoch !== nextEpoch))) {
        void refreshAnalyticsPreferences();
      }
    });
    chrome.permissions.onRemoved.addListener(() => void refreshAnalyticsPreferences());
    // One observer per extension document, including restoration from a frozen page.
    const resume = () => {
      if (listeners.size && !document.hidden) void refreshAnalyticsPreferences();
    };
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', resume);
  }
  void refreshAnalyticsPreferences();
  return () => {listeners.delete(listener);};
}

export function useAnalyticsPreferences() {
  return useSyncExternalStore(subscribe, () => snapshot, () => initial);
}
