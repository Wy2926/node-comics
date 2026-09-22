import { msg } from '../../i18n/runtime';
import type { SourceCatalog } from '../../library/types';
import type { PageManifest } from '../contracts/source';
import { pollSourceDiscovery } from '../core/discovery';
import { sameSource } from '../core/identity';
import { definitions } from '../registry/definitions';
const sameSourcePage = (a: string, b: string) => sameSource(a, b, definitions);
export const inExtension = () => typeof chrome !== 'undefined' && !!chrome.runtime?.id;
export async function sourceMessage<T>(message: unknown): Promise<T> {
  if (!inExtension()) throw Error(msg('网站采集需在已安装的浏览器插件中执行。'));
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw Error(result?.error ?? msg('插件通信失败，请重新打开阅读器。'));
  return result.data as T;
}
export async function discoverEntry(
  catalog: SourceCatalog,
  entryId: string,
  signal: AbortSignal,
  onProgress: (manifest: PageManifest) => Promise<void>,
  assertActive?: () => Promise<void>,
  firstLinksOnly = false,
) {
  signal.throwIfAborted();
  await sourceMessage({ type: 'NC_REGISTER_CATALOG', catalog });
  const { tabId } = await sourceMessage<{ tabId: number }>({
    type: 'NC_OPEN_SOURCE',
    catalogId: catalog.id,
    entryId,
  });
  try {
    return await pollSourceDiscovery(
      () => sourceMessage<PageManifest | null>({ type: 'NC_POLL_SOURCE', tabId }),
      {
        signal,
        onProgress,
        assertActive,
        isComplete: firstLinksOnly ? (manifest) => manifest.items.length > 0 : undefined,
      },
    );
  } finally {
    await sourceMessage({ type: 'NC_CLOSE_SOURCE', tabId }).catch(() => {});
  }
}
export async function discoverCatalog(url: string): Promise<SourceCatalog> {
  if (!inExtension()) throw Error(msg('网站采集需在已安装的浏览器插件中执行。'));
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id == null) throw Error(msg('无法打开来源页面。'));
  try {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const t = await chrome.tabs.get(tab.id);
      if (t.url !== url && t.status === 'complete' && (!t.url || !sameSourcePage(t.url, url)))
        throw Error(msg('来源页面跳转，请回源核实。'));
      if (t.status !== 'complete') continue;
      const result = await sourceMessage<{ kind: string; catalog?: SourceCatalog }>({
        type: 'NC_DISCOVER_TAB',
        tabId: tab.id,
      });
      if (result.catalog?.complete) return { ...result.catalog, excludedEntryIds: [] };
    }
    throw Error(msg('目录未完整加载，请打开来源页处理后重试。'));
  } finally {
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (current?.url && (current.url === url || sameSourcePage(current.url, url)))
      await chrome.tabs.remove(tab.id);
  }
}
