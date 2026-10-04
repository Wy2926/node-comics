import {msg} from '../../i18n/runtime';
import {resolveSource} from '../core/resolve';
import {validateCatalog} from '../core/catalog';
import {definitions} from '../registry/definitions';
import type {SourceCatalogSnapshot} from '../contracts/source';
import {networkOperation,readNetworkCatalog} from './network';
import {ownsSourceTab as owns,rememberSourceTab,releaseSourceTab} from './source-tabs';

/** Read the adapter's complete directory without creating import records or loading chapter images. */
export async function readSourceCatalog(url:string,options:{previous?:SourceCatalogSnapshot;signal?:AbortSignal;onCatalogProgress?:(snapshot:SourceCatalogSnapshot)=>Promise<void>}={}):Promise<SourceCatalogSnapshot> {
  options.signal?.throwIfAborted();
  if(networkOperation(url,'catalog'))return readNetworkCatalog(url,options);
  const {location} = resolveSource(url, definitions);
  const tab = await chrome.tabs.create({url, active:false});
  if (tab.id == null) throw Error(msg('无法打开来源页面。'));
  try {
    await rememberSourceTab(tab.id,url,Date.now()+60_000);
    const deadline = Date.now() + 20_000;
    let progressReported=false;
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 500));
      options.signal?.throwIfAborted();
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
      options.signal?.throwIfAborted();
      if (snapshot.id !== location.catalog?.key || !owns(snapshot.url, url)) throw Error('SOURCE_CATALOG_CHANGED');
      if (snapshot.complete && snapshot.groups.every(group => group.complete)) return snapshot;
      if (!snapshot.complete&&!progressReported&&snapshot.entries.some(entry=>!entry.related&&entry.readable!==false)) {
        await options.onCatalogProgress?.(snapshot);
        progressReported=true;
        options.signal?.throwIfAborted();
      }
    }
    throw Error(msg('目录未完整加载，请打开来源页处理后重试。'));
  } finally {
    await releaseSourceTab(tab.id,url);
  }
}
