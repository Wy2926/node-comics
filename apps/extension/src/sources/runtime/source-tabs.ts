import { sameSource } from '../core/identity';
import { definitions } from '../registry/definitions';

// Retain the existing session key so an extension update can recover older catalog tabs.
const prefix = 'nc-catalog-tab:';
const recoveryAlarm = 'nc-source-tabs';
const mutate = <T>(run: () => Promise<T>) => navigator.locks.request('nc-source-tabs', {}, run);

export const ownsSourceTab = (url: string | undefined, expected: string) =>
  !!url && sameSource(url, expected, definitions);

/** Register recovery before starting work, including when the owning reader closes abruptly. */
export async function rememberSourceTab(tabId: number, url: string, expiresAt: number, exact = false) {
  await mutate(async () => {
    await chrome.storage.session.set({ [prefix + tabId]: { url, expiresAt, ...(exact ? { exact: true } : {}) } });
    const alarm = await chrome.alarms.get(recoveryAlarm);
    if (!alarm || alarm.scheduledTime > expiresAt) {
      await chrome.alarms.create(recoveryAlarm, { when: expiresAt });
    }
  });
}

export async function releaseSourceTab(tabId: number, url: string, exact = false) {
  const current = await chrome.tabs.get(tabId).catch(() => undefined);
  const target = current?.pendingUrl ?? current?.url;
  if (exact ? target === url : ownsSourceTab(target, url)) {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
  await chrome.storage.session.remove(prefix + tabId);
}

/** Recover expired owned tabs, never user navigations or still-running leases. */
export async function recoverSourceTabs() {
  await mutate(async () => {
    const records = await chrome.storage.session.get(null);
    let next = Infinity;
    for (const [key, value] of Object.entries(records)) {
      const record = value as { url?: unknown; expiresAt?: unknown; exact?: unknown } | undefined;
      if (!key.startsWith(prefix) || !record || typeof record.url !== 'string' ||
          typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) continue;
      const tabId = Number(key.slice(prefix.length));
      if (!Number.isSafeInteger(tabId) || tabId < 0) continue;
      if (record.expiresAt <= Date.now()) await releaseSourceTab(tabId, record.url, record.exact === true);
      else next = Math.min(next, record.expiresAt);
    }
    if (Number.isFinite(next)) await chrome.alarms.create(recoveryAlarm, { when: next });
    else await chrome.alarms.clear(recoveryAlarm);
  });
}

/** Source resource cleanup is independent of library catalog synchronization. */
export function registerSourceTabRecovery() {
  const recover = () => { void recoverSourceTabs().catch(() => {}); };
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === recoveryAlarm) recover(); });
  // Alarms may be lost across a browser restart; restore the next lease on worker startup.
  recover();
}
