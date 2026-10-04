import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {SourceDefinition} from '../src/sources/contracts/definition';
import type {SourceNetwork} from '../src/sources/contracts/network';
import type {SourceImageAdapter} from '../src/sources/contracts/image';
import type {SourceSearchHit, SourceSearchRequest} from '../src/sources/contracts/search';
const fixture = vi.hoisted(() => ({definitions: [] as SourceDefinition[], networks: {} as Record<string, SourceNetwork>,
  images: {} as Record<string,SourceImageAdapter>,pageCover:vi.fn(),headers: vi.fn(() => ({referer: 'https://fixture.test/'}))}));
vi.mock('../src/sources/registry/definitions', () => ({definitions: fixture.definitions}));
vi.mock('../src/sources/registry/networks', () => ({sourceNetworks: fixture.networks}));
vi.mock('../src/sources/registry/images', () => ({sourceImages: fixture.images}));
vi.mock('../src/sources/runtime/page-cover', () => ({readPageCover: fixture.pageCover}));
vi.mock('../src/sources/runtime/image-headers', () => ({withImageHeaders: async (_url: string, _headers: unknown, _signal: unknown, read: () => Promise<unknown>) => read()}));
import {normalizeSourceSearchRequest, validateSearchCapability, validateSearchPage} from '../src/sources/core/search';
import {createSourceNetworkContext, SourceHttpError} from '../src/sources/runtime/http';
import {listSearchSites, readSearchCover, releaseSourceSearchSession, searchSource} from '../src/sources/runtime/search';

const query = (): SourceSearchRequest => ({siteId: 'main', query: 'Example'});
const hit = (extra: Partial<SourceSearchHit> = {}): SourceSearchHit => ({catalogId: 'fixture:one', catalogUrl: 'https://fixture.test/book/one', title: 'Example', ...extra});
const definition = (): SourceDefinition => ({id: 'fixture', name: 'Fixture',
  capabilities: {importable: true, catalog: true, pages: true, completePageList: true, inline: false},
  installation: {autoContentMatches: []},
  sites: [{id: 'main', name: 'Fixture', url: 'https://fixture.test/', icon: '/fixture.svg', primaryLanguages: ['en'], adaptedOn: '2026-09-23', contentTags: ['manga'],
    search: true}],
  identify(url) {
    if (!['fixture.test', 'mirror.test'].includes(url.hostname)) return null;
    const id = /^\/book\/([a-z]+)$/.exec(url.pathname)?.[1];
    return {sourceId: this.id, pageKey: this.id + ':' + (id ?? url.pathname), kind: id ? 'catalog' : 'other', url: url.href,
      ...(id ? {catalog: {key: this.id + ':' + id, url: url.href}} : {})};
  }});
const site = () => fixture.definitions[0].sites![0];
const validate = (items: SourceSearchHit[]) => validateSearchPage({items}, fixture.definitions[0], site(), fixture.definitions);
beforeEach(() => {
  fixture.definitions.splice(0, fixture.definitions.length, definition());
  fixture.networks.fixture = {search: vi.fn(async () => ({items: [hit()]}))};
  fixture.headers.mockClear();
  fixture.images.fixture={coverHeaders:fixture.headers};fixture.pageCover.mockReset().mockResolvedValue(new Blob(['page cover']));
  vi.stubGlobal('chrome', {runtime: {id: 'fixture'}, permissions: {contains: vi.fn(async () => true), request: vi.fn(async () => true)}});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('fixture')));
});
afterEach(() => {
  for (const id of ['session', 'other', 'timeout', 'cancelled']) releaseSourceSearchSession(id);
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('name-only search and candidate authority', () => {
  it('lists capable sites without language filtering or match status', () => {
    expect(listSearchSites()).toHaveLength(1);
    expect(listSearchSites()[0]).toMatchObject({id: 'main', primaryLanguages: ['en']});
    expect(listSearchSites()[0]).not.toHaveProperty('languageMatch');
  });
  it('preserves actual source languages for display and never infers missing languages', () => {
    expect(validate([hit({contentLanguages: ['en', 'zh-hk', 'zh-HK']})]).items[0]).toMatchObject({contentLanguages: ['en', 'zh-HK']});
    for (const item of [hit(), hit({contentLanguages: []})]) {
      const result = validate([item]).items[0];
      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('contentLanguages');
      expect(result).not.toHaveProperty('languageMatch');
    }
    expect(() => validate([hit({contentLanguages: ['invalid_language']})])).toThrow('SOURCE_SEARCH_INVALID');
  });
  it('deduplicates proven source identity and rejects forged identity, URL and cover values', () => {
    const result = validate([hit(), hit({catalogUrl: 'https://mirror.test/book/one'})]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({key: '["fixture","fixture:one"]', sourceId: 'fixture', siteId: 'main'});
    for (const extra of [{catalogId: 'another:one'}, {catalogUrl: 'https://fixture.test/reader/one'},
      {catalogUrl: 'https://fixture.test.evil.test/book/one'}, {cover: {url: 'javascript:alert(1)'}}])
      expect(() => validate([hit(extra)])).toThrow();
    expect(() => validate(Array.from({length: 51}, () => hit()))).toThrow('SOURCE_SEARCH_INVALID');
  });
  it('validates Unicode query budgets and requires importable catalog search capability', () => {
    expect(normalizeSourceSearchRequest({...query(), query: ' 😀 '})).toEqual({siteId: 'main', query: '😀'});
    expect(() => normalizeSourceSearchRequest({...query(), query: '😀'.repeat(257)})).toThrow();
    expect(() => normalizeSourceSearchRequest({...query(), query: 'bad\nquery'})).toThrow();
    expect(validateSearchCapability(fixture.definitions[0], site())).toBe(true);
    for (const capability of ['importable', 'catalog'] as const) {
      const definition = fixture.definitions[0];
      expect(() => validateSearchCapability({...definition, capabilities: {...definition.capabilities, [capability]: false}}, site())).toThrow();
    }
    site().search = undefined;
    expect(() => validateSearchCapability(fixture.definitions[0], site())).toThrow();
  });
});

describe('single-site search runtime', () => {
  it('binds cursors to the session, site and query without exposing the adapter cursor', async () => {
    const operation = vi.fn<NonNullable<SourceNetwork['search']>>(async () => ({items: [hit()], nextCursor: 'adapter-page-2'}));
    fixture.networks.fixture.search = operation;
    const first = await searchSource('fixture', query(), {sessionId: 'session'});
    expect(first.nextCursor).toBeTruthy(); expect(first.nextCursor).not.toBe('adapter-page-2');
    await searchSource('fixture', {...query(), cursor: first.nextCursor}, {sessionId: 'session'});
    expect(operation.mock.calls[1][0].cursor).toBe('adapter-page-2');
    fixture.definitions[0].sites = [...fixture.definitions[0].sites!, {...site(), id: 'mirror'}];
    for (const changed of [{query: 'different'}, {siteId: 'mirror'}, {cursor: 'unissued'}])
      await expect(searchSource('fixture', {...query(), cursor: first.nextCursor, ...changed}, {sessionId: 'session'})).rejects.toMatchObject({code: 'SOURCE_SEARCH_CURSOR_EXPIRED'});
    await expect(searchSource('fixture', {...query(), cursor: first.nextCursor}, {sessionId: 'other'})).rejects.toMatchObject({code: 'SOURCE_SEARCH_CURSOR_EXPIRED'});
    releaseSourceSearchSession('session');
    await expect(searchSource('fixture', {...query(), cursor: first.nextCursor}, {sessionId: 'session'})).rejects.toMatchObject({code: 'SOURCE_SEARCH_CURSOR_EXPIRED'});
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it('checks the actual API host before fetching without opening a per-site permission prompt', async () => {
    fixture.networks.fixture.search = async (_request, context) => {await context.request('https://api.example.test/search'); return {items: []};};
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
    await expect(searchSource('fixture', query(), {sessionId: 'session'})).rejects.toMatchObject({code: 'SOURCE_SEARCH_PERMISSION_REQUIRED'});
    expect(chrome.permissions.contains).toHaveBeenCalledExactlyOnceWith({origins: ['https://api.example.test/*']});
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('allows trusted adapters to select API hosts without a host declaration or an extra permission preflight', async () => {
    fixture.networks.fixture.search = async (_request, context) => {
      await context.request('https://api.example.test/search', {referer: 'https://fixture.test/'});
      await context.request('https://mirror.test/api');
      return {items: [hit()]};
    };
    expect((await searchSource('fixture', query(), {sessionId: 'session'})).items).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(chrome.permissions.contains).toHaveBeenCalledTimes(2);
    expect(chrome.permissions.contains).toHaveBeenNthCalledWith(1, {origins: ['https://api.example.test/*']});
    expect(chrome.permissions.contains).toHaveBeenNthCalledWith(2, {origins: ['https://mirror.test/*']});
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });
  it('rechecks browser access before each request and stops a revoked search before its next fetch', async () => {
    fixture.networks.fixture.search = async (_request, context) => {
      await context.request('https://fixture.test/api');
      vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
      await context.request('https://fixture.test/api?page=2');
      return {items: []};
    };
    await expect(searchSource('fixture', query(), {sessionId: 'session'})).rejects.toMatchObject({code: 'SOURCE_SEARCH_PERMISSION_REQUIRED'});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://fixture.test/api', expect.objectContaining({redirect: 'error', credentials: 'include'}));
  });
  it.each([
    [429, 'SOURCE_SEARCH_RATE_LIMITED'], [401, 'SOURCE_SEARCH_VERIFICATION_REQUIRED'],
    [403, 'SOURCE_SEARCH_VERIFICATION_REQUIRED'], [503, 'SOURCE_SEARCH_HTTP_ERROR'],
  ])('maps HTTP %i to %s at the search boundary and keeps retry-after', async (status, code) => {
    vi.mocked(fetch).mockResolvedValue(new Response('', {status, headers: {'retry-after': '23'}}));
    fixture.networks.fixture.search = async (_request, context) => {await context.request('https://fixture.test/api'); return {items: []};};
    await expect(searchSource('fixture', query(), {sessionId: 'session'})).rejects.toMatchObject({code, retryAfter: 23});
  });
  it('maps an empty body and an oversized response without accepting partial search results', async () => {
    fixture.networks.fixture.search = async (_request, context) => {await context.request('https://fixture.test/api'); return {items: [hit()]};};
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null));
    await expect(searchSource('fixture', query(), {sessionId: 'session'})).rejects.toMatchObject({code: 'SOURCE_SEARCH_HTTP_ERROR'});
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
    await expect(searchSource('fixture', query(), {sessionId: 'session'})).rejects.toMatchObject({code: 'SOURCE_SEARCH_INVALID'});
  });
  it('enforces the deadline even when an adapter ignores its signal', async () => {
    vi.useFakeTimers();
    fixture.networks.fixture.search = async () => new Promise(() => {});
    const result = searchSource('fixture', query(), {sessionId: 'timeout'});
    const assertion = expect(result).rejects.toMatchObject({code: 'SOURCE_SEARCH_TIMEOUT'});
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
  it('rejects late results after cancellation without registering a result cover', async () => {
    let finish!: (value: {items: SourceSearchHit[]}) => void;
    fixture.networks.fixture.search = async () => new Promise(resolve => {finish = resolve;});
    const result = searchSource('fixture', query(), {sessionId: 'cancelled'});
    const assertion = expect(result).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    releaseSourceSearchSession('cancelled');
    finish({items: [hit({cover: {url: 'https://images.test/late.png'}})]});
    await assertion;
    await expect(readSearchCover({...hit({cover: {url: 'https://images.test/late.png'}}), key: '["fixture","fixture:one"]',
      sourceId: 'fixture', siteId: 'main'})).rejects.toMatchObject({code: 'SOURCE_SEARCH_INVALID'});
  });
  it('reads observed search artwork through image permissions and site cover headers without fake catalogs', async () => {
    fixture.networks.fixture.search = async () => ({items: [hit({cover: {url: 'https://images.test/cover.png'}})]});
    const result = await searchSource('fixture', query(), {sessionId: 'session'}), candidate = result.items[0];
    expect(await (await readSearchCover(candidate)).text()).toBe('fixture');
    expect(fixture.headers).toHaveBeenCalledExactlyOnceWith('https://images.test/cover.png');
    expect(chrome.permissions.contains).toHaveBeenCalledWith({origins: ['https://images.test/*']});
    await expect(readSearchCover({...candidate, cover: {url: 'https://images.test/forged.png'}})).rejects.toMatchObject({code: 'SOURCE_SEARCH_INVALID'});
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
    await expect(readSearchCover(candidate)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('honors the same explicit image-document cover transport after search candidate validation',async()=>{
    fixture.images.fixture.coverTransport='page';
    const url='https://images.test/page-cover.png';
    fixture.networks.fixture.search=async()=>({items:[hit({cover:{url}})]});
    const candidate=(await searchSource('fixture',query(),{sessionId:'session'})).items[0];
    expect(await(await readSearchCover(candidate)).text()).toBe('page cover');
    expect(fixture.pageCover).toHaveBeenCalledExactlyOnceWith(url,undefined);
    await expect(readSearchCover({...candidate,cover:{url:url+'?forged'}})).rejects.toMatchObject({code:'SOURCE_SEARCH_INVALID'});
    expect(fixture.pageCover).toHaveBeenCalledOnce();expect(fixture.headers).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
});

describe('shared source HTTP transport', () => {
  it('reads explicitly accepted error bodies without relaxing other statuses or body limits', async () => {
    const context = createSourceNetworkContext();
    const options = {referer: 'https://fixture.test/book/one', acceptStatuses: [404]};
    vi.mocked(fetch).mockResolvedValueOnce(new Response('empty result', {status: 404}));
    await expect(context.request('https://fixture.test/search', options)).resolves.toBe('empty result');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('denied', {status: 403}));
    await expect(context.request('https://fixture.test/search', options)).rejects.toMatchObject({details: {status: 403}});
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1), {status: 404}));
    await expect(context.request('https://fixture.test/search', options)).rejects.toMatchObject({kind: 'invalid-response'});
  });
  it('rechecks actual request hosts without an operation allowlist and preserves denied replay data', async () => {
    const context = createSourceNetworkContext(undefined,
      [{url: 'https://api.fixture.test/catalog', body: 'retained'}]);
    await expect(context.request('https://fixture.test/catalog')).resolves.toBe('fixture');
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
    await expect(context.request('https://fixture.test/catalog?page=2')).rejects.toMatchObject({kind: 'permission-required'});
    expect(chrome.permissions.contains).toHaveBeenLastCalledWith({origins: ['https://fixture.test/*']});
    await expect(context.request('https://api.fixture.test/catalog')).rejects.toMatchObject({kind: 'permission-required'});
    expect(chrome.permissions.contains).toHaveBeenLastCalledWith({origins: ['https://api.fixture.test/*']});
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(chrome.permissions.contains).mockImplementation(async () => true);
    await expect(context.request('https://api.fixture.test/catalog')).resolves.toBe('retained');
    expect(chrome.permissions.contains).toHaveBeenLastCalledWith({origins: ['https://api.fixture.test/*']});
    expect(chrome.permissions.request).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps public HTTP available outside the extension without a browser permission API', async () => {
    vi.stubGlobal('chrome', undefined);
    const context = createSourceNetworkContext();
    await expect(context.request('https://fixture.test/catalog')).resolves.toBe('fixture');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves directory HTTP error messages and reports status without search business codes', async () => {
    const context = createSourceNetworkContext();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', {status: 403, headers: {'retry-after': '7'}}));
    const error = await context.request('https://fixture.test/catalog').catch(error => error);
    expect(error).toBeInstanceOf(SourceHttpError);
    expect(error).toMatchObject({kind: 'http', message: '来源请求失败（HTTP 403），请稍后重试或在源站完成验证。', details: {status: 403, retryAfter: 7}});
    expect(error).not.toHaveProperty('code');
    expect(fetch).toHaveBeenCalledWith('https://fixture.test/catalog', expect.objectContaining({credentials: 'include', redirect: 'error'}));
  });
  it('keeps invalid address, referer and body diagnostics for directory callers', async () => {
    const context = createSourceNetworkContext();
    await expect(context.request('javascript:alert(1)')).rejects.toMatchObject({kind: 'request-denied', message: '来源请求地址无效。'});
    await expect(context.request('https://fixture.test/catalog', {referer: 'javascript:alert(1)'})).rejects.toMatchObject({kind: 'request-denied', message: '来源请求 Referer 地址无效。'});
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null));
    await expect(context.request('https://fixture.test/catalog')).rejects.toMatchObject({kind: 'http', message: '来源响应为空。'});
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
    await expect(context.request('https://fixture.test/catalog')).rejects.toMatchObject({kind: 'invalid-response', message: '来源响应超过限制。'});
  });
  it('checks browser access before consuming a replay and uses it only once', async () => {
    const context = createSourceNetworkContext(undefined,
      [{url: 'https://fixture.test/catalog', body: 'retained'}]);
    vi.mocked(chrome.permissions.contains).mockImplementationOnce(async () => false);
    await expect(context.request('https://fixture.test/catalog')).rejects.toMatchObject({kind: 'permission-required'});
    expect(fetch).not.toHaveBeenCalled();
    await expect(context.request('https://fixture.test/catalog')).resolves.toBe('retained');
    await expect(context.request('https://fixture.test/catalog')).resolves.toBe('fixture');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
