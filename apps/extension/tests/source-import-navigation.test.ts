import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {SourceCatalogSnapshot} from '../src/sources/contracts/source';
import {registerSourceBackground} from '../src/sources/runtime/background';

vi.mock('../src/i18n/background', () => ({registerLocaleBackground: () => async () => {}}));
vi.mock('../src/inline/background', () => ({activateInline: vi.fn(), registerInlineBackground: vi.fn()}));

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown;
let listener: Listener;
const catalogUrl = 'https://comic.naver.com/webtoon/list?titleId=123';
const readerUrl = 'https://comic.naver.com/webtoon/detail?titleId=123&no=2';
const snapshot: SourceCatalogSnapshot = {
  id: 'naver:webtoon:123', sourceId: 'naver', url: catalogUrl, title: 'Fixture', observedAt: 1,
  complete: true, note: '', groups: [], entries: [{id: 'episode-2', remoteId: '2', catalogId: 'naver:webtoon:123',
    url: readerUrl, title: 'Episode 2', groupIds: [], rawTypes: [], order: 0, related: false}],
};
let currentUrl: string;
let readCatalog: ReturnType<typeof vi.fn<(url: string) => Promise<SourceCatalogSnapshot>>>;
let create: ReturnType<typeof vi.fn>, set: ReturnType<typeof vi.fn>;
const sender = (url = 'https://comic.naver.com/webtoon'): chrome.runtime.MessageSender => ({
  id: 'test', url, frameId: 0, tab: {id: 7, url: currentUrl} as chrome.tabs.Tab,
});
async function send(from = sender()) {
  return new Promise(resolve => {
    const keepAlive = listener({type: 'NC_IMPORT_CURRENT'}, from, resolve);
    if (keepAlive !== true) resolve(undefined);
  });
}
beforeEach(() => {
  currentUrl = catalogUrl;
  readCatalog = vi.fn(async () => structuredClone(snapshot));
  create = vi.fn(async () => ({id: 8})); set = vi.fn(async () => {});
  vi.stubGlobal('chrome', {
    runtime: {id: 'test', getURL: (url: string) => 'chrome-extension://test' + url,
      onInstalled: {addListener() {}}, onMessage: {addListener(fn: Listener) {listener = fn;}}},
    contextMenus: {onClicked: {addListener() {}}},
    storage: {local: {set}},
    tabs: {get: async () => ({id: 7, url: currentUrl}), create},
  });
  registerSourceBackground(readCatalog);
});
afterEach(() => vi.unstubAllGlobals());

describe('embedded import after same-document navigation', () => {
  it.each([catalogUrl, readerUrl])('imports the current page despite a stale homepage sender URL: %s', async url => {
    currentUrl = url;
    expect(await send()).toEqual({ok: true});
    expect(readCatalog).toHaveBeenCalledExactlyOnceWith(catalogUrl);
    expect(create).toHaveBeenCalledExactlyOnceWith({url: expect.stringMatching(/reader.html\?catalog=/)});
    const importId = new URL(create.mock.calls[0][0].url).searchParams.get('catalog');
    expect(set).toHaveBeenCalledWith({['nc-import:' + importId]: {catalog: {
      ...snapshot, ...(url === readerUrl ? {defaultEntryId: 'episode-2'} : {}),
    }}});
  });
  it('keeps direct catalog imports working', async () => {
    expect(await send(sender(catalogUrl))).toEqual({ok: true});
    expect(readCatalog).toHaveBeenCalledExactlyOnceWith(catalogUrl);
  });
  it.each(['https://comic.naver.com/webtoon', 'https://comic.naver.com/webtoon/list?titleId=invalid',
    'https://www.gunnerkrigg.com/?p=123', 'https://comic.naver.com.evil.test/webtoon/list?titleId=123'])
  ('rejects a current page outside the importable source scope: %s', async url => {
    currentUrl = url;
    expect(await send()).toMatchObject({ok: false});
    expect(readCatalog).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it.each([{id: 'foreign'}, {frameId: 1}, {tab: undefined}, {url: undefined},
    {url: 'https://comic.naver.com.evil.test/webtoon'}, {url: 'http://comic.naver.com/webtoon'}])
  ('does not accept an unauthorized sender: %j', async changes => {
    expect(await send({...sender(), ...changes})).toBeUndefined();
    expect(readCatalog).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it('returns a failed catalog read without opening a reader, then allows retry', async () => {
    readCatalog.mockRejectedValueOnce(Error('unavailable'));
    expect(await send()).toMatchObject({ok: false});
    expect(create).not.toHaveBeenCalled();
    expect(await send()).toEqual({ok: true});
    expect(create).toHaveBeenCalledOnce();
  });
});
