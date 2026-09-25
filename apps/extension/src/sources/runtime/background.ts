import { registerLocaleBackground } from '../../i18n/background';
import { msg } from '../../i18n/runtime';
import { sourceFailure } from './diagnostics';

import { activateInline, registerInlineBackground } from '../../inline/background';
import type { SourceCatalog } from '../../comics/application/types';
import { pollSourceDiscovery } from '../core/discovery';
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
import {networkOperation,readNetworkPages} from './network';
import {readImportCatalog} from './import';
import {sourceImages} from '../registry/images';
import {recoverImageHeaders} from './image-headers';
import {registerDocumentManifest} from './manifests';
import {readSourceCatalog} from './catalog-reader';
import type {DocumentSnapshot,SourceCatalogSnapshot} from '../contracts/source';
const sourceMessageTypes = new Set([
  'NC_IMPORT_CURRENT',
  'NC_TRANSLATE_TAB',
  'NC_DISCOVER_TAB',
  'NC_OPEN_PAGE',
  'NC_REGISTER_CATALOG',
  'NC_OPEN_SOURCE',
  'NC_POLL_SOURCE',
  'NC_CLOSE_SOURCE',
  'NC_SOURCE_IMAGE',
]);
function trusted(sender: chrome.runtime.MessageSender) {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}
async function inject(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] });
}
async function discover(tabId: number,readCatalog:(url:string)=>Promise<SourceCatalogSnapshot>, senderUrl?: string) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !safeImageUrl(tab.url, tab.url)) throw Error(msg('请打开普通漫画网页。'));
  if (senderUrl && new URL(tab.url).origin !== new URL(senderUrl).origin)
    throw Error(msg('来源页面已变化，请重新发现。'));
  const { definition, location: loc } = sourceFor(tab.url);
  if(!definition.capabilities.importable||loc.kind==='other')throw Error('此网站尚未专门适配，不能导入漫画。');
  if (definition.capabilities.catalog && (loc.kind==='reader'||networkOperation(tab.url,'catalog'))) {
    const catalog = await readImportCatalog(tab.url,readCatalog), id = crypto.randomUUID();
    await chrome.storage.local.set({['nc-import:' + id]: {catalog}});
    return {kind: 'catalog', id, catalog};
  }
  if(loc.kind==='reader'&&networkOperation(tab.url,'pages')){
    const manifest=await readNetworkPages(tab.url);return {kind:'pages',id:manifest.id,manifest};
  }
  await inject(tabId);
  if (loc.kind === 'catalog' && definition.capabilities.catalog) {
    const snapshot = await chrome.tabs.sendMessage(tabId, { type: 'NC_CATALOG_SNAPSHOT' }, { frameId: 0 });
    if (snapshot?.error) throw Error(snapshot.code ?? snapshot.error);
    const catalog = validateSourceCatalog(snapshot);
    if (catalog.id !== loc.catalog?.key || !sameSourcePage(catalog.url, tab.url))
      throw Error(msg('来源详情页已变化。'));
    const id = crypto.randomUUID();
    await chrome.storage.local.set({
      ['nc-import:' + id]: { catalog, sourceTabId: tabId },
    });
    return { kind: 'catalog', id, catalog };
  }
  const read = async () => {
    const snapshot = await chrome.tabs.sendMessage(tabId, { type: 'NC_DISCOVER' }, { frameId: 0 });
    if (snapshot?.error) throw Error(snapshot.code ?? snapshot.error);
    if (!snapshot || snapshot.url !== tab.url || !Array.isArray(snapshot.items))
      throw Error(msg('来源页面已变化，请重新发现。'));
    return snapshot as DocumentSnapshot;
  };
  const result =
    loc.kind === 'reader' && definition.capabilities.completePageList
      ? await pollSourceDiscovery(read)
      : await read();
  const manifest = await registerDocumentManifest(result, tabId);
  return { kind: 'pages', id: manifest.id, manifest };
}
export function registerSourceBackground(readCatalog:(url:string)=>Promise<SourceCatalogSnapshot> = readSourceCatalog) {
  const localeReady = registerLocaleBackground();
  registerInlineBackground();
  void recoverImageHeaders().catch(()=>{});
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
      }),
    );
  });
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'nc-translate-page' && tab?.id != null) {
      try {
        // Request before any await: loading locale/storage can lose the menu's user gesture.
        const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
        if (!granted) return;
        await localeReady();
        await activateInline(tab.id);
      } catch {
        await chrome.tabs.create({ url: chrome.runtime.getURL('/reader.html#settings') });
      }
      return;
    }

  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    // Other background protocols share this event. Returning true or responding to
    // an unowned message would race their reply, even for a trusted extension page.
    if (!sourceMessageTypes.has(message?.type)) return;
    if (message.type === 'NC_IMPORT_CURRENT') {
      // Chrome can retain the document's original sender.url after pushState.
      // Authenticate the source here; discover validates the current tab's page and origin.
      const fromSourcePage =
        sender.id === chrome.runtime.id &&
        sender.tab?.id != null &&
        sender.frameId === 0 &&
        !!sourceLocation(sender.url ?? '') &&
        sourceFor(sender.url??'').definition.capabilities.importable;
      if (!fromSourcePage) return;
      void discover(sender.tab!.id!,readCatalog,sender.url)
        .then((result) =>
          chrome.tabs.create({ url: chrome.runtime.getURL('/reader.html?'+(result.kind==='catalog'?'catalog':'manifest')+'=' + result.id) }),
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
      if (message?.type === 'NC_DISCOVER_TAB') return discover(Number(message.tabId),readCatalog);
      if (message?.type === 'NC_OPEN_PAGE') {
        const resolved=sourceFor(String(message.url));
        if(!resolved.definition.capabilities.importable||resolved.location.kind!=='reader')throw Error('SOURCE_IMPORT_UNSUPPORTED');
        const tab=await chrome.tabs.create({url:resolved.location.url,active:false});
        if(tab.id==null)throw Error(msg('无法打开来源。'));
        await chrome.storage.session.set({['nc-managed:'+tab.id]:{url:resolved.location.url,manifestId:crypto.randomUUID()}});
        return {tabId:tab.id};
      }
      if (message?.type === 'NC_REGISTER_CATALOG') {
        const catalog = validateSourceCatalog(message.catalog);
        if(!sourceFor(catalog.url).definition.capabilities.importable)throw Error('SOURCE_IMPORT_UNSUPPORTED');
        await chrome.storage.local.set({ ['nc-source:' + catalog.id]: catalog });
        return true;
      }
      if (message?.type === 'NC_OPEN_SOURCE') {
        const data = await chrome.storage.local.get('nc-source:' + message.catalogId);
        const catalog = data['nc-source:' + message.catalogId] as SourceCatalog | undefined;
        const entry = catalog?.entries.find((e) => e.id === message.entryId);
        if (!entry) throw Error(msg('条目不在已确认来源目录中。'));
        validateSourceCatalog(catalog);
        if (!sourceFor(entry.url).definition.capabilities.importable||!sourceFor(entry.url).definition.capabilities.pages)
          throw Error('SOURCE_COLLECTION_UNSUPPORTED');
        const tab = await chrome.tabs.create({ url: entry.url, active: false });
        if (tab.id == null) throw Error(msg('无法打开来源。'));
        await chrome.storage.session.set({ ['nc-managed:' + tab.id]: { url: entry.url, manifestId: crypto.randomUUID() } });
        return { tabId: tab.id };
      }
      if (message?.type === 'NC_POLL_SOURCE' || message?.type === 'NC_CLOSE_SOURCE') {
        const tabId = Number(message.tabId),
          data = await chrome.storage.session.get('nc-managed:' + tabId);
        const managed = data['nc-managed:' + tabId] as { url: string; manifestId: string } | undefined;
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
        return registerDocumentManifest(snapshot, tabId, managed.manifestId);
      }
      if (message?.type === 'NC_SOURCE_IMAGE') {
        const data = await chrome.storage.local.get('manifest:' + message.manifestId),
          manifest = data['manifest:' + message.manifestId] as PageManifest | undefined;
        const authority=manifest&&sourceFor(manifest.url);
        if(!authority?.definition.capabilities.importable||manifest?.adapter!==authority.definition.id)throw Error('SOURCE_IMPORT_UNSUPPORTED');
        const item = manifest?.items.find((i) => i.id === message.pageId);
        if (
          !manifest ||
          !item ||
          !(item.kind === 'page' ? isPageImageUrl(item.url) : safeImageUrl(item.url, manifest.url) === item.url)
        )
          throw Error(msg('图片不在来源清单内。'));
        // HTTP locators are durable registered metadata. Only page resources depend on
        // the original tab and navigation; managed discovery closes its tab on completion.
        if (item.kind !== 'page') {
          return {url:item.url,pageUrl:manifest.url,...(item.processing||sourceImages[manifest.adapter]?{sourceId:manifest.adapter,processing:item.processing}:{})};
        }
        const pageContext=manifest.pageContext;
        if(!pageContext)throw Error(msg('来源页已改变，请重新发现。'));
        const current = await chrome.tabs
          .sendMessage(pageContext.tabId, { type: 'NC_NAVIGATION' }, { frameId: 0 })
          .catch(() => null);
        if (current?.url !== manifest.url || current.navigationId !== pageContext.navigationId)
          throw Error(msg('来源页已改变，请重新发现。'));
        if (item.kind === 'page') {
          const source = await chrome.tabs.sendMessage(
            pageContext.tabId,
            {
              type: 'NC_PAGE_IMAGE',
              navigationId: pageContext.navigationId,
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
      }
      throw Error(msg('不支持的操作。'));
    })()
      .then((data) => respond({ ok: true, data }))
      .catch((error) => respond({ ok: false, ...sourceFailure(error) }));
    return true;
  });
}
