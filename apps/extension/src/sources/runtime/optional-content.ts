import {definitions} from '../registry/definitions';
import {hostPermissionPattern} from '../../host-permissions';

const prefix = 'nc-source-entry-';
const byIdentity = definitions.filter(definition => definition.installation.optionalContentByIdentity);
async function injectIdentifiedTab(tab: chrome.tabs.Tab) {
  if (tab.id == null || !tab.url || tab.status === 'loading') return;
  const url = new URL(tab.url);
  if (!byIdentity.some(definition => definition.identify(url))) return;
  if (await chrome.permissions.contains({origins: [hostPermissionPattern(url.href)]}))
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['content-scripts/content.js']});
}
/** Optional site entries persist across navigation/restarts without adding installation permissions. */
export async function syncOptionalSourceContent(injectExisting = false) {
  await navigator.locks.request('nc-source-entry-registration', async () => {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const desired = new Set<string>();
    for (const definition of definitions) {
      const matches: string[] = [];
      for (const pattern of definition.installation.optionalContentMatches ?? []) {
        if (await chrome.permissions.contains({origins: [pattern]})) matches.push(pattern);
      }
      if (!matches.length) continue;
      const id = prefix + definition.id;
      desired.add(id);
      const script: chrome.scripting.RegisteredContentScript = {
        id, matches, js: ['content-scripts/content.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
      };
      if (registered.some(value => value.id === id)) await chrome.scripting.updateContentScripts([script]);
      else await chrome.scripting.registerContentScripts([script]);
      if (injectExisting) {
        for (const tab of await chrome.tabs.query({url: matches})) {
          if (tab.id != null) await chrome.scripting.executeScript({target: {tabId: tab.id}, files: script.js!}).catch(() => {});
        }
      }
    }
    const stale = registered.filter(value => value.id.startsWith(prefix) && !desired.has(value.id)).map(value => value.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ids: stale});
    if (injectExisting && byIdentity.length) {
      for (const tab of await chrome.tabs.query({})) await injectIdentifiedTab(tab).catch(() => {});
    }
  });
}
export function registerOptionalSourceContent() {
  const refresh = () => { void syncOptionalSourceContent(true).catch(() => {}); };
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (change.status === 'complete') void injectIdentifiedTab(tab).catch(() => {});
  });
  chrome.permissions.onAdded.addListener(refresh);
  chrome.permissions.onRemoved.addListener(refresh);
  chrome.runtime.onInstalled.addListener(refresh);
  refresh();
}
