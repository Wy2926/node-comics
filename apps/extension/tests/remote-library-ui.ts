import { saveSettings } from '../src/comics/application/preferences';
import { defaults } from '../src/types';

if (location.origin !== 'http://127.0.0.1:5199') throw Error('Use the isolated http://127.0.0.1:5199 origin.');
const request = globalThis.fetch.bind(globalThis), blockedRequests: string[] = [];
globalThis.fetch = async (input, init) => {
  const resource = new Request(input instanceof Request ? input : new URL(String(input), location.href), init), url = new URL(resource.url);
  if (!['GET', 'HEAD'].includes(resource.method) || url.origin !== location.origin && !['blob:', 'data:'].includes(url.protocol)) {
    if (blockedRequests.length === 100) blockedRequests.shift();
    blockedRequests.push(url.origin + url.pathname);
    throw new TypeError('External/product API and writes disabled in remote library UI fixture');
  }
  return request(resource);
};
Object.assign(window, { remoteLibraryUiFixture: { blockedRequests } });
const parameters = new URLSearchParams(location.search);
await saveSettings({ ...defaults, uiLanguage: 'zh-CN', appearance: parameters.get('theme') === 'dark' ? 'dark' : 'light' });
if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '#remote-library');
await import('../src/main');
