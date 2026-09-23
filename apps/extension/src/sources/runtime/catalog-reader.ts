import {msg} from '../../i18n/runtime';
import {resolveSource} from '../core/resolve';
import {sameSource} from '../core/identity';
import {validateCatalog} from '../core/catalog';
import {definitions} from '../registry/definitions';
import type {SourceCatalogSnapshot} from '../contracts/source';

const prefix = 'nc-catalog-tab:';
const owns = (url:string | undefined, expected:string) => !!url && sameSource(url, expected, definitions);

/** Recover abandoned background tabs after a worker restart; leave user navigations alone. */
export async function recoverCatalogTabs() {
  const records = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(records)) {
    const record = value as {url?:unknown; expiresAt?:unknown} | undefined;
    if (!key.startsWith(prefix) || !record || typeof record.url !== 'string' ||
        typeof record.expiresAt !== 'number' || record.expiresAt > Date.now()) continue;
    const tabId = Number(key.slice(prefix.length));
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (owns(tab?.pendingUrl ?? tab?.url, record.url)) await chrome.tabs.remove(tabId).catch(() => {});
    await chrome.storage.session.remove(key);
  }
}

/** Read the adapter's complete directory without creating import records or loading chapter images. */
export async function readSourceCatalog(url:string):Promise<SourceCatalogSnapshot> {
  const {definition, location} = resolveSource(url, definitions);
  if (!definition.capabilities.importable || !definition.capabilities.catalog || location.kind !== 'catalog')
    throw Error('SOURCE_CATALOG_UNSUPPORTED');
  const tab = await chrome.tabs.create({url, active:false});
  if (tab.id == null) throw Error(msg('无法打开来源页面。'));
  const key = prefix + tab.id;
  try {
    await chrome.storage.session.set({[key]:{url, expiresAt:Date.now() + 60_000}});
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const current = await chrome.tabs.get(tab.id);
      if (current.pendingUrl && !owns(current.pendingUrl, url) || current.status === 'complete' && !owns(current.url, url))
        throw Error(msg('来源页面跳转，请回源核实。'));
      if (current.status !== 'complete') continue;
      await chrome.scripting.executeScript({target:{tabId:tab.id}, files:['content-scripts/content.js']});
      const value = await chrome.tabs.sendMessage(tab.id, {type:'NC_CATALOG_SNAPSHOT'}, {frameId:0});
      if (value?.error) {
        if (value.code === 'SOURCE_NOT_READY') continue;
        throw Error(value.code ?? 'CATALOG_DISCOVERY_FAILED');
      }
      const snapshot = validateCatalog(value, definitions);
      if (snapshot.id !== location.catalog?.key || !owns(snapshot.url, url)) throw Error('SOURCE_CATALOG_CHANGED');
      if (snapshot.complete && snapshot.groups.every(group => group.complete)) return snapshot;
    }
    throw Error(msg('目录未完整加载，请打开来源页处理后重试。'));
  } finally {
    const current = await chrome.tabs.get(tab.id).catch(() => undefined);
    if (owns(current?.pendingUrl ?? current?.url, url)) await chrome.tabs.remove(tab.id).catch(() => {});
    await chrome.storage.session.remove(key);
  }
}
