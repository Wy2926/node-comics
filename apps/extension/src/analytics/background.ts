import { API_BASE } from '../service';
import { createAnalyticsEngine, analyticsStorageKey, type AnalyticsState } from './engine';
import { analyticsPermission } from './permissions';
import { sanitizeEvent } from './schema';
import { analyticsPromptStorageKey, createAnalyticsPreferences } from './prompt';
import { currentInlineActivation } from '../inline/activation';

const alarmName = 'nc-analytics-flush';

export function extensionAnalyticsSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab?.incognito !== true && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}

/** Only a currently activated top-frame inline script may emit content-side events. */
export async function controlledAnalyticsSender(sender: chrome.runtime.MessageSender, navigationId?: unknown): Promise<boolean> {
  if (extensionAnalyticsSender(sender))
    return true;
  if (sender.tab?.incognito)
    return false;
  try {
    return !!await currentInlineActivation(sender, navigationId);
  } catch {
    return false;
  }
}

function browserCategory() {
  const agent = navigator.userAgent;
  if (agent.includes('Firefox/')) return 'firefox';
  if (agent.includes('Edg/')) return 'edge';
  if (agent.includes('Chrome/')) return 'chrome';
  return 'other';
}

export function registerAnalyticsBackground() {
  const engine = createAnalyticsEngine({
    read: async () => {
      const saved = await chrome.storage.local.get(analyticsStorageKey);
      return saved[analyticsStorageKey] as AnalyticsState | undefined;
    },
    write: state => chrome.storage.local.set({ [analyticsStorageKey]: state }),
    allowed: async () => chrome.extension?.inIncognitoContext !== true && await analyticsPermission(),
    common: () => ({ browser: browserCategory(), extension_version: chrome.runtime.getManifest().version }),
    send: async (body, signal) => {
      const response = await fetch(API_BASE.replace(/\/$/, '') + '/v1/analytics/events', {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      return response.status;
    },
    wake: delay => { void chrome.alarms.create(alarmName, { when: Date.now() + Math.max(1000, delay) }); },
    clearWake: () => { void chrome.alarms.clear(alarmName); },
  });
  const preferences = createAnalyticsPreferences({
    read: async () => {
      const saved = await chrome.storage.local.get([analyticsStorageKey, analyticsPromptStorageKey]);
      const stored = saved[analyticsStorageKey] as AnalyticsState | undefined;
      return { prompt: saved[analyticsPromptStorageKey] as boolean | undefined, consent: stored?.consent, consented_at: stored?.consented_at };
    },
    writePrompt: handled => chrome.storage.local.set({ [analyticsPromptStorageKey]: handled }),
    enabled: engine.enabled,
    setConsent: engine.setConsent,
  });
  // The store includes a pseudonymous analytics ID; never expose it to website scripts.
  void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => { });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['NC_ANALYTICS_TRACK', 'NC_ANALYTICS_STATUS', 'NC_ANALYTICS_CONSENT'].includes(message?.type))
      return;
    void (async () => {
      if (message.type === 'NC_ANALYTICS_TRACK') {
        if (!await controlledAnalyticsSender(sender, message.navigationId))
          return { ok: false };
        const event = sanitizeEvent(message.name, message.params);
        if (!event)
          return { ok: false };
        if (!Number.isSafeInteger(message.startedAt) || message.startedAt < 0)
          return { ok: false };
        await engine.track(event.name, event.params, message.startedAt);
        return { ok: true };
      }
      if (message.type === 'NC_ANALYTICS_STATUS') {
        if (!await controlledAnalyticsSender(sender, message.navigationId)) return { ok: false };
        const state = await preferences.status();
        return extensionAnalyticsSender(sender)
          ? { ok: true, ...state }
          : { ok: true, enabled: state.enabled, consentedAt: state.consentedAt };
      }
      if (!extensionAnalyticsSender(sender)) return { ok: false };
      if (typeof message.enabled !== 'boolean')
        return { ok: false };
      return { ok: true, ...await preferences.choose(message.enabled) };
    })().then(respond, () => respond({ ok: false }));
    return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === alarmName) void engine.flush().catch(() => {});
  });
  chrome.permissions.onRemoved.addListener(() => {
    void analyticsPermission().then(allowed => {
      if (!allowed) return engine.setConsent(false);
    }).catch(() => {});
  });
  void engine.flush().catch(() => {});
}
