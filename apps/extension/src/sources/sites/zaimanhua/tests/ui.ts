// Local browser fixture. Tests real import/repository/reader with real public images,
// NOT MV3 host permissions/DNR. No production accounts, translation, or source writes.
import type {PageManifest} from '../../../contracts/source';
if (location.origin !== 'http://127.0.0.1:5203') throw Error('Isolated test origin required');
const originalFetch = globalThis.fetch.bind(globalThis);
const rules: chrome.declarativeNetRequest.Rule[] = [];
const saved: Record<string, unknown> = JSON.parse(localStorage.getItem('zai-fixture-storage') ?? '{}');
const event = {addListener() {}, removeListener() {}};
const storage = {
  async get(keys: string | string[]) {return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, saved[key]]));},
  async set(value: Record<string, unknown>) {Object.assign(saved, value); localStorage.setItem('zai-fixture-storage', JSON.stringify(saved));},
  async remove(keys: string | string[]) {for (const key of typeof keys === 'string' ? [keys] : keys) delete saved[key]; localStorage.setItem('zai-fixture-storage', JSON.stringify(saved));},
};
Object.assign(globalThis, {chrome: {
  runtime: {id: 'zai-local-ui-fixture', getURL: (value: string) => new URL(value, location.origin + '/').href,
    onMessage: event, sendMessage: async (message: {type: string; manifestId?: string; pageId?: string}) => {
      if (message.type === 'NC_SOURCE_IMAGE') {
        const manifest = saved['manifest:' + message.manifestId] as PageManifest | undefined;
        const item = manifest?.adapter === 'zaimanhua' && manifest.items.find(item => item.id === message.pageId);
        if (item && new URL(item.url).hostname === 'images.zaimanhua.com') return {ok: true, data: {url: item.url, pageUrl: manifest!.url}};
      }
      return {ok: false, error: 'Unavailable in local UI fixture'};
    }},
  storage: {local: storage, session: storage, onChanged: event},
  permissions: {contains: async () => true, onAdded: event, onRemoved: event},
  declarativeNetRequest: {getSessionRules: async () => rules,
    updateSessionRules: async ({removeRuleIds = [], addRules = []}: {removeRuleIds?: number[]; addRules?: chrome.declarativeNetRequest.Rule[]}) => {
      for (let i = rules.length - 1; i >= 0; i--) if (removeRuleIds.includes(rules[i].id)) rules.splice(i, 1);
      rules.push(...addRules);
    }},
}});
globalThis.fetch = async (input, init) => {
  const resource = new Request(input, init), url = new URL(resource.url);
  if (['www.zaimanhua.com', 'manhua.zaimanhua.com', 'images.zaimanhua.com'].includes(url.hostname)) {
    if (resource.method !== 'GET') throw Error('Read-only source fixture');
    return originalFetch('/__zai_live?url=' + encodeURIComponent(url.href), {signal: resource.signal, credentials: 'omit'});
  }
  if (url.origin === location.origin || ['blob:', 'data:'].includes(url.protocol)) return originalFetch(input, init);
  throw new TypeError('Unrelated request blocked in source UI test');
};
const {saveSettings} = await import('../../../../comics/application/preferences');
const {defaults} = await import('../../../../types');
if (!localStorage.getItem('zai-ui-initialized')) {
  await saveSettings({...defaults, uiLanguage: 'zh-CN', layout: 'single', fit: 'window', autoTranslateTabs: false, discoveryTextTranslation: false});
  localStorage.setItem('zai-ui-initialized', '1');
}
await import('../../../../main');
