import {nextCatalogCheckAt, syncNextCatalog} from './catalog-sync';
import {recoverCatalogTabs} from '../../sources';

export const CATALOG_SYNC_ALARM = 'nc-catalog-sync';
export const CATALOG_CONTINUE_ALARM = 'nc-catalog-sync-continue';
export function registerCatalogSyncBackground() {
  let running:Promise<void> | undefined;
  const run = () => running ??= (async () => {
    // Schedule recovery before doing work: termination can happen before the finally block runs.
    await chrome.alarms.create(CATALOG_CONTINUE_ALARM, {when:Date.now()+120_000});
    await recoverCatalogTabs();
    // Keep network work sequential and bounded. Persisted due times survive worker suspension.
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && await syncNextCatalog()) { /* drain due comics */ }
  })().catch(() => {}).finally(async () => {
    try {
      const next = await nextCatalogCheckAt();
      if (Number.isFinite(next)) await chrome.alarms.create(CATALOG_CONTINUE_ALARM, {when:Math.max(Date.now()+30_000,next)});
      else await chrome.alarms.clear(CATALOG_CONTINUE_ALARM);
    } catch { /* The periodic alarm retries if the local database is temporarily unavailable. */ }
    finally {running = undefined;}
  });
  const schedule = async () => {
    if (!await chrome.alarms.get(CATALOG_SYNC_ALARM))
      await chrome.alarms.create(CATALOG_SYNC_ALARM, {periodInMinutes:720, delayInMinutes:720});
  };
  chrome.alarms.onAlarm.addListener(alarm => {if ([CATALOG_SYNC_ALARM,CATALOG_CONTINUE_ALARM].includes(alarm.name)) void run();});
  chrome.runtime.onStartup.addListener(() => {void schedule().then(run).catch(() => {});});
  chrome.runtime.onInstalled.addListener(() => {void schedule().then(run).catch(() => {});});
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'NC_CHECK_DUE_CATALOGS' || sender.id !== chrome.runtime.id ||
        !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    void schedule().then(() => {void run(); respond({ok:true});}, () => respond({ok:false}));
    return true;
  });
  // Alarms may disappear across a browser restart. Recreate them whenever this worker starts.
  void schedule().then(run).catch(() => {});
}
