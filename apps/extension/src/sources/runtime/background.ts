import { registerLocaleBackground } from '../../i18n/background';
import { msg } from '../../i18n/runtime';
import { sourceFailure } from './diagnostics';

import { activateInline, registerInlineBackground } from '../../inline/background';
import type { SourceCatalog } from '../../library/types';
import { pollSourceDiscovery } from '../core/discovery';
import { selectManifest } from '../core/selection';
import {
  safeImageUrl,
  sameSourcePage,
  sourceFor,
  sourceLocation,
  validateSourceCatalog,
  type PageManifest,
} from '../index';
import { maxInlineBytes } from '../shared/bytes';
import { isPageImageUrl } from '../shared/urls';
function trusted(sender: chrome.runtime.MessageSender) {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}
async function inject(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] });
}
async function discover(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !safeImageUrl(tab.url, tab.url)) throw Error(msg('请打开普通漫画网页。'));
  await inject(tabId);
  const { definition, location: loc } = sourceFor(tab.url);
  if (loc.kind === 'catalog' && definition.capabilities.catalog) {
    const snapshot = await chrome.tabs.sendMessage(tabId, { type: 'NC_CATALOG_SNAPSHOT' }, { frameId: 0 });
    if (snapshot?.error) throw Error(snapshot.code ?? snapshot.error);
    const catalog = validateSourceCatalog(snapshot);
    if (catalog.id !== loc.catalog?.key || !sameSourcePage(catalog.url, tab.url))
      throw Error(msg('来源详情页已变化。'));
    const id = crypto.randomUUID();
    await chrome.storage.local.set({
      ['nc-import:' + id]: { catalog: { ...catalog, excludedEntryIds: [] }, sourceTabId: tabId },
    });
    return { kind: 'catalog', id, catalog };
  }
  const read = async () => {
    const snapshot = await chrome.tabs.sendMessage(tabId, { type: 'NC_DISCOVER' }, { frameId: 0 });
    if (snapshot?.error) throw Error(snapshot.code ?? snapshot.error);
    if (!snapshot || snapshot.url !== tab.url || !Array.isArray(snapshot.items))
      throw Error(msg('来源页面已变化，请重新发现。'));
    return snapshot as PageManifest;
  };
  const result =
    loc.kind === 'reader' && definition.capabilities.completePageList
      ? await pollSourceDiscovery(read)
      : await read();
  const id = crypto.randomUUID();
  const manifest = { ...result, id, sourceTabId: tabId } as PageManifest;
  manifest.items = manifest.items.filter((i) =>
    i.kind === 'page' ? isPageImageUrl(i.url) : safeImageUrl(i.url, tab.url!) === i.url,
  );
  await chrome.storage.local.set({ ['manifest:' + id]: manifest });
  return { kind: 'pages', id, manifest };
}
export function registerSourceBackground() {
  const localeReady = registerLocaleBackground();
  registerInlineBackground();
  void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  chrome.runtime.onInstalled.addListener(() => {
    void localeReady().then(() =>
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
          id: 'nc-translate-page',
          title: msg('翻译当前页面'),
          contexts: ['page', 'image', 'link', 'selection'],
          documentUrlPatterns: ['http://*/*', 'https://*/*'],
        });
        chrome.contextMenus.create({
          id: 'nc-read-image',
          title: msg('在 NodeLane Comics 中阅读 / 翻译'),
          contexts: ['image'],
        });
      }),
    );
  });
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    await localeReady();
    if (info.menuItemId === 'nc-translate-page' && tab?.id != null) {
      // A webpage's image CDN can be on any origin; Chrome asks once, in this user gesture.
      const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
      if (granted)
        await activateInline(tab.id).catch(() =>
          chrome.tabs.create({ url: chrome.runtime.getURL('/reader.html#settings') }),
        );
      return;
    }
    if (info.menuItemId !== 'nc-read-image' || !tab?.id || !tab.url) return;
    const url = safeImageUrl(info.srcUrl ?? '', tab.url);
    if (!url) return;
    await inject(tab.id);
    const source = await chrome.tabs.sendMessage(tab.id, { type: 'NC_NAVIGATION' }, { frameId: 0 });
    if (source?.url !== tab.url) return;
    const id = crypto.randomUUID();
    const manifest: PageManifest = {
      id,
      sourceTabId: tab.id,
      navigationId: source.navigationId,
      revision: 1,
      title: tab.title ?? msg('网页图片'),
      url: tab.url,
      adapter: 'context-menu',
      direction: 'rtl',
      discoveryComplete: false,
      note: msg('右键导入的单张图片。'),
      items: [{ id: 'slot-0', url, width: 800, height: 1200, order: 0 }],
    };
    await chrome.storage.local.set({ ['manifest:' + id]: manifest });
    await chrome.tabs.create({ url: chrome.runtime.getURL('/reader.html?manifest=' + id) });
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const fromDetail =
      sender.id === chrome.runtime.id &&
      sender.tab?.id != null &&
      sender.frameId === 0 &&
      sourceLocation(sender.url ?? '')?.kind === 'catalog';
    if (message?.type === 'NC_IMPORT_CURRENT' && fromDetail) {
      void discover(sender.tab!.id!)
        .then((result) =>
          chrome.tabs.create({ url: chrome.runtime.getURL('/reader.html?catalog=' + result.id) }),
        )
        .then(() => respond({ ok: true }))
        .catch(() => respond({ ok: false, error: msg('目录读取失败，请通过插件弹窗重试。') }));
      return true;
    }
    if (!trusted(sender)) return;
    (async () => {
      await localeReady();
      if (message?.type === 'NC_TRANSLATE_TAB') {
        if (!Number.isInteger(message.tabId) || message.tabId < 0)
          throw Error(msg('当前标签页不可用，请重新打开插件。'));
        const tab = await chrome.tabs.get(message.tabId);
        if (!tab.url || !safeImageUrl(tab.url, tab.url)) throw Error(msg('请在普通网页中使用翻译。'));
        if (tab.url !== message.url) throw Error(msg('当前网页已变化，请重新打开插件后翻译。'));
        await activateInline(message.tabId);
        return true;
      }
      if (message?.type === 'NC_DISCOVER_TAB') return discover(Number(message.tabId));
      if (message?.type === 'NC_SELECT_MANIFEST') {
        const data = await chrome.storage.local.get('manifest:' + message.manifestId),
          original = data['manifest:' + message.manifestId] as PageManifest | undefined;
        if (!original) throw Error(msg('来源清单已失效，请重新发现。'));
        const manifest = { ...selectManifest(original, message.itemIds), id: crypto.randomUUID() };
        await chrome.storage.local.set({ ['manifest:' + manifest.id]: manifest });
        return { id: manifest.id };
      }
      if (message?.type === 'NC_REGISTER_CATALOG') {
        const catalog = validateSourceCatalog(message.catalog);
        await chrome.storage.local.set({ ['nc-source:' + catalog.id]: catalog });
        return true;
      }
      if (message?.type === 'NC_OPEN_SOURCE') {
        const data = await chrome.storage.local.get('nc-source:' + message.catalogId);
        const catalog = data['nc-source:' + message.catalogId] as SourceCatalog | undefined;
        const entry = catalog?.entries.find((e) => e.id === message.entryId);
        if (!entry) throw Error(msg('条目不在已确认来源目录中。'));
        validateSourceCatalog(catalog);
        if (!sourceFor(entry.url).definition.capabilities.completePageList)
          throw Error('SOURCE_COLLECTION_UNSUPPORTED');
        const tab = await chrome.tabs.create({ url: entry.url, active: false });
        if (tab.id == null) throw Error(msg('无法打开来源。'));
        await chrome.storage.session.set({ ['nc-managed:' + tab.id]: { url: entry.url } });
        return { tabId: tab.id };
      }
      if (message?.type === 'NC_POLL_SOURCE' || message?.type === 'NC_CLOSE_SOURCE') {
        const tabId = Number(message.tabId),
          data = await chrome.storage.session.get('nc-managed:' + tabId);
        const managed = data['nc-managed:' + tabId] as { url: string } | undefined;
        if (!managed) throw Error(msg('采集标签页已失效。'));
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (message.type === 'NC_CLOSE_SOURCE') {
          if (tab?.url && (tab.url === managed.url || sameSourcePage(tab.url, managed.url)))
            await chrome.tabs.remove(tabId);
          await chrome.storage.session.remove('nc-managed:' + tabId);
          return true;
        }
        if (!tab) throw Error(msg('采集页已关闭，请重试。'));
        if (tab.status !== 'complete') {
          if (
            tab.pendingUrl &&
            tab.pendingUrl !== managed.url &&
            !sameSourcePage(tab.pendingUrl, managed.url)
          )
            throw Error(msg('采集页正在跳转到其他地址。'));
          return null;
        }
        if (tab.url !== managed.url) {
          if (!tab.url || !sameSourcePage(tab.url, managed.url))
            throw Error(msg('采集页已跳转，请回源处理后重试。'));
          managed.url = tab.url;
          await chrome.storage.session.set({ ['nc-managed:' + tabId]: managed });
        }
        await inject(tabId);
        const snapshot = await chrome.tabs.sendMessage(tabId, { type: 'NC_DISCOVER' }, { frameId: 0 });
        if (snapshot?.error) throw Error(snapshot.code ?? snapshot.error);
        if (snapshot?.url !== managed.url) throw Error(msg('来源归属已变化。'));
        return snapshot;
      }
      if (message?.type === 'NC_SOURCE_IMAGE') {
        const data = await chrome.storage.local.get('manifest:' + message.manifestId),
          manifest = data['manifest:' + message.manifestId] as PageManifest | undefined;
        const item = manifest?.items.find((i) => i.id === message.pageId);
        if (
          !manifest ||
          !item ||
          !(item.kind === 'page' ? isPageImageUrl(item.url) : safeImageUrl(item.url, manifest.url))
        )
          throw Error(msg('图片不在来源清单内。'));
        const current = await chrome.tabs
          .sendMessage(manifest.sourceTabId, { type: 'NC_NAVIGATION' }, { frameId: 0 })
          .catch(() => null);
        if (current?.url !== manifest.url || current.navigationId !== manifest.navigationId)
          throw Error(msg('来源页已改变，请重新发现。'));
        if (item.kind === 'page') {
          const source = await chrome.tabs.sendMessage(
            manifest.sourceTabId,
            {
              type: 'NC_PAGE_IMAGE',
              navigationId: manifest.navigationId,
              url: manifest.url,
              imageUrl: item.url,
              pageId: item.id,
            },
            { frameId: 0 },
          );
          if (
            typeof source?.data !== 'string' ||
            source.data.length > (maxInlineBytes * 4) / 3 + 200 ||
            !/^data:image\/png;base64,/.test(source.data)
          )
            throw Error(source?.error ?? msg('网页原图读取失败。'));
          return { url: item.url, data: source.data };
        }
        return { url: item.url };
      }
      throw Error(msg('不支持的操作。'));
    })()
      .then((data) => respond({ ok: true, data }))
      .catch((error) => respond({ ok: false, ...sourceFailure(error) }));
    return true;
  });
}
