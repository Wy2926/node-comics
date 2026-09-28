import {afterEach, expect, it, vi} from 'vitest';
import {registerAnalyticsBackground} from '../src/analytics/background';
import {analyticsStorageKey, type AnalyticsState} from '../src/analytics/engine';

afterEach(() => vi.unstubAllGlobals());

it('preserves task start times across the runtime bridge before applying consent', async () => {
  const consentedAt = Date.now();
  const saved: Record<string, unknown> = {
    [analyticsStorageKey]: {consent: true, consented_at: consentedAt, queue: []},
  };
  type MessageListener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (response: unknown) => void,
  ) => unknown;
  let listener: MessageListener = () => {};
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('navigator', {userAgent: 'Chrome/140'});
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'self',
      getURL: (path: string) => 'chrome-extension://self/' + path,
      getManifest: () => ({version: '0.6.0'}),
      onMessage: {addListener: (receive: MessageListener) => {listener = receive;}},
    },
    storage: {session: {get: async () => ({'nc-inline:7': {navigationId: 'active-navigation', url: 'https://source.test/book'}})}, local: {
      get: async () => structuredClone(saved),
      set: async (values: Record<string, unknown>) => {Object.assign(saved, structuredClone(values));},
      setAccessLevel: async () => {},
    }},
    tabs: {get: async () => ({id: 7, url: 'https://source.test/book'})},
    alarms: {create: vi.fn(), clear: vi.fn(), onAlarm: {addListener: vi.fn()}},
    permissions: {onRemoved: {addListener: vi.fn()}},
  });
  registerAnalyticsBackground();
  const contentSender = {id: 'self', url: 'https://source.test/book', frameId: 0, tab: {id: 7}} as chrome.runtime.MessageSender;
  const contentMessage = (message: unknown) => new Promise(resolve => listener(message, contentSender, resolve));
  expect(await contentMessage({type: 'NC_ANALYTICS_STATUS', navigationId: 'active-navigation'})).toEqual({ok: true, enabled: true, consentedAt});
  expect(await contentMessage({type: 'NC_ANALYTICS_STATUS', navigationId: 'old-navigation'})).toEqual({ok: false});
  expect(await contentMessage({type: 'NC_ANALYTICS_CONSENT', navigationId: 'active-navigation', enabled: false})).toEqual({ok: false});
  const emit = (startedAt: unknown) => new Promise(resolve => {
    listener({
      type: 'NC_ANALYTICS_TRACK',
      name: 'import_result',
      params: {outcome: 'success', duration_ms: 1000},
      startedAt,
    }, {id: 'self', url: 'chrome-extension://self/reader.html'}, resolve);
  });
  expect(await emit(consentedAt - 1000)).toEqual({ok: true});
  expect((saved[analyticsStorageKey] as AnalyticsState).queue).toEqual([]);
  expect(await emit('invalid timestamp')).toEqual({ok: false});
  expect(await emit(consentedAt)).toEqual({ok: true});
  const queue = (saved[analyticsStorageKey] as AnalyticsState).queue;
  expect(queue.map(event => event.name)).toEqual(['extension_first_use', 'import_result']);
  expect(JSON.stringify(queue)).not.toContain('startedAt');
  const before = queue.length;
  expect(await contentMessage({type: 'NC_ANALYTICS_TRACK', navigationId: 'active-navigation', name: 'translation_viewed', params: {surface: 'inline'}, startedAt: consentedAt})).toEqual({ok: true});
  expect((saved[analyticsStorageKey] as AnalyticsState).queue).toHaveLength(before + 1);
  expect(JSON.stringify(saved[analyticsStorageKey])).not.toContain('active-navigation');
  expect(fetch).not.toHaveBeenCalled();
});
