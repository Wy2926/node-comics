import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {SourceNetwork} from '../src/sources/contracts/network';
import type {ImportResponse} from '../src/sources/runtime/import-responses';

const fixture = vi.hoisted(() => ({networks: {} as Record<string, SourceNetwork>, remember: vi.fn(), headers: vi.fn()}));
vi.mock('../src/sources/registry/networks', () => ({sourceNetworks: fixture.networks}));
vi.mock('../src/sources/registry/definitions', () => ({definitions: [{
  id: 'fixture', name: 'Fixture', capabilities: {importable: true, pages: true, catalog: true, inline: false, completePageList: true},
  installation: {autoContentMatches: []},
  identify: (url: URL) => url.origin === 'https://fixture.test' ? {sourceId: 'fixture', url: url.href, pageKey: url.pathname,
    kind: url.pathname === '/book' ? 'catalog' : 'reader',
    ...(url.pathname === '/unbound' ? {} : {catalog: {key: 'fixture:book', url: 'https://fixture.test/book'}})} : null,
}]}));
vi.mock('../src/sources/runtime/image-headers', () => ({withImageHeaders: async (url: string, headers: unknown, signal: AbortSignal,
  read: () => Promise<unknown>) => {fixture.headers(url, headers); signal.throwIfAborted(); return read();}}));
vi.mock('../src/sources/runtime/import-responses', () => ({
  importResponseLimits: {bytes: 2 * 1024 * 1024, count: 8}, rememberImportResponses: fixture.remember,
  takeImportResponses: vi.fn(async () => []),
}));
import {createSourceNetworkContext} from '../src/sources/runtime/http';
import {resolveNetworkCatalog} from '../src/sources/runtime/network';

const source = 'https://fixture.test/book/one', endpoint = 'https://fixture.test/ajax', options = {referer: source, form: {action: 'pages'}};
let fetcher: ReturnType<typeof vi.fn<(url: string, options?: RequestInit) => Promise<Response>>>;
let permission: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
beforeEach(() => {
  fetcher = vi.fn(async () => new Response('source response'));
  permission = vi.fn(async () => true);
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('chrome', {runtime: {id: 'fixture'}, permissions: {contains: permission}});
  fixture.headers.mockClear(); fixture.remember.mockClear(); delete fixture.networks.fixture;
});
afterEach(() => {vi.unstubAllGlobals();});

describe('bounded source form POST', () => {
  it('encodes string fields as UTF-8 form data, including spaces, punctuation and non-ASCII text', async () => {
    const form = Object.assign(Object.create(null), {action: 'load pages', chapter: '日本語 + &=', 'pages[]': '7'});
    expect(await createSourceNetworkContext().request(endpoint, {referer: source, form})).toBe('source response');
    const request = fetcher.mock.calls[0][1]!;
    expect(request).toMatchObject({method: 'POST', credentials: 'include',
      headers: {Accept: 'application/json, text/html', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'}});
    expect(request.body).toBe('action=load+pages&chapter=%E6%97%A5%E6%9C%AC%E8%AA%9E+%2B+%26%3D&pages%5B%5D=7');
    expect(permission).toHaveBeenCalledExactlyOnceWith({origins: ['https://fixture.test/*']});
    expect(fixture.headers).toHaveBeenCalledExactlyOnceWith(endpoint, {referer: source});
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });
  it('keeps ordinary requests as GET without form-specific body or content type', async () => {
    await createSourceNetworkContext().request(endpoint);
    expect(fetcher.mock.calls[0][1]).toMatchObject({credentials: 'include', headers: {Accept: 'application/json, text/html'}});
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('method');
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('Content-Type');
  });
  it('allows an explicitly empty form POST and bounds the actual encoded byte length', async () => {
    const context = createSourceNetworkContext(), limit = 1024 * 1024;
    await context.request(endpoint, {referer: source, form: {}});
    expect(fetcher.mock.calls[0][1]).toMatchObject({method: 'POST', body: ''});
    await context.request(endpoint, {referer: source, form: {a: 'x'.repeat(limit - 2)}});
    expect((fetcher.mock.calls[1][1]?.body as string).length).toBe(limit);
    fetcher.mockClear();
    for (const form of [{a: 'x'.repeat(limit - 1)}, {a: '日'.repeat(120_000)}])
      await expect(context.request(endpoint, {referer: source, form})).rejects.toMatchObject({kind: 'request-denied'});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects malformed records, fields and values without invoking accessors', async () => {
    const getter = vi.fn(() => 'pages');
    const invalid: unknown[] = [null, 'action=pages', ['pages'], new URLSearchParams({action: 'pages'}),
      {action: 1}, {action: undefined}, {'': 'pages'}, {'bad\nkey': 'pages'},
      {[Symbol('action')]: 'pages'}, Object.create({action: 'pages'}),
      Object.defineProperty({}, 'action', {enumerable: true, get: getter}),
      Object.defineProperty({}, 'action', {enumerable: false, value: 'pages'})];
    for (const form of invalid)
      await expect(createSourceNetworkContext().request(endpoint, {referer: source,
        form: form as Readonly<Record<string, string>>})).rejects.toMatchObject({kind: 'request-denied'});
    expect(getter).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(fixture.headers).not.toHaveBeenCalled();
  });
  it('checks browser access and URL validity for POST', async () => {
    permission.mockResolvedValueOnce(false);
    await expect(createSourceNetworkContext().request(endpoint, options)).rejects.toMatchObject({kind: 'permission-required'});
    for (const referer of ['javascript:alert(1)', 'https://user:secret@fixture.test/book/one', 'file:///book/one'])
      await expect(createSourceNetworkContext().request(endpoint, {...options, referer})).rejects.toMatchObject({kind: 'request-denied'});
    expect(fetcher).not.toHaveBeenCalled(); expect(fixture.headers).not.toHaveBeenCalled();
  });
  it('uses adapter-selected API and Referer hosts without requiring declarations or shared source identity', async () => {
    const target = 'https://api.example.test/pages', referer = 'https://reader.example.test/book/one';
    expect(await createSourceNetworkContext().request(target, {...options, referer})).toBe('source response');
    expect(permission).toHaveBeenCalledExactlyOnceWith({origins: ['https://api.example.test/*']});
    expect(fixture.headers).toHaveBeenCalledExactlyOnceWith(target, {referer});
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(target, expect.objectContaining({method: 'POST', body: 'action=pages'}));
  });
  it('honors cancellation before permission checks, after permission checks and while consuming responses', async () => {
    const before = new AbortController(); before.abort();
    await expect(createSourceNetworkContext(before.signal).request(endpoint, options)).rejects.toThrow();
    expect(permission).not.toHaveBeenCalled();
    const checking = new AbortController(); permission.mockImplementationOnce(async () => {checking.abort(); return true;});
    await expect(createSourceNetworkContext(checking.signal).request(endpoint, options)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const fetching = new AbortController(), cancel = vi.fn();
    fetcher.mockImplementationOnce(async () => {
      fetching.abort(); return new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array([97]));}, cancel}));
    });
    await expect(createSourceNetworkContext(fetching.signal).request(endpoint, options)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('retains response status and size limits, allowing only explicitly accepted error statuses', async () => {
    const context = createSourceNetworkContext();
    fetcher.mockResolvedValueOnce(new Response('structured missing result', {status: 404}));
    expect(await context.request(endpoint, {...options, acceptStatuses: [404]})).toBe('structured missing result');
    fetcher.mockResolvedValueOnce(new Response('rate limited', {status: 429, headers: {'Retry-After': '17'}}));
    await expect(context.request(endpoint, options)).rejects.toMatchObject({kind: 'http', details: {status: 429, retryAfter: 17}});
    fetcher.mockResolvedValueOnce(new Response('redirect', {status: 302}));
    await expect(context.request(endpoint, {...options, acceptStatuses: [302]})).rejects.toMatchObject({kind: 'http', details: {status: 302}});
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(8 * 1024 * 1024 + 1)));
    await expect(context.request(endpoint, options)).rejects.toMatchObject({kind: 'invalid-response'});
  });
  it('never reads or consumes GET replay responses when submitting a form', async () => {
    const replay: ImportResponse[] = [{url: endpoint, referer: source, body: 'GET replay'}];
    const context = createSourceNetworkContext(undefined, replay);
    expect(await context.request(endpoint, options)).toBe('source response');
    expect(replay).toHaveLength(1); expect(fetcher).toHaveBeenCalledOnce();
    expect(await context.request(endpoint, {referer: source})).toBe('GET replay');
    expect(replay).toEqual([]); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('excludes form responses from parent-resolution handoff and its GET retention budget', async () => {
    const unbound = 'https://fixture.test/unbound';
    fixture.networks.fixture = {resolveCatalog: async (_url, context) => {
      await context.request(endpoint, {referer: unbound, form: {action: 'resolve'}});
      await context.request(endpoint, {referer: unbound});
      return 'https://fixture.test/book';
    }};
    fetcher.mockResolvedValueOnce(new Response('p'.repeat(1100_000))).mockResolvedValueOnce(new Response('GET response'));
    expect(await resolveNetworkCatalog(unbound)).toBe('https://fixture.test/book');
    expect(fixture.remember).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url: unbound}), 'fixture:book',
      [{url: endpoint, referer: unbound, body: 'GET response'}], expect.any(AbortSignal));
    expect(fetcher.mock.calls.map(([, request]) => request?.method ?? 'GET')).toEqual(['POST', 'GET']);
  });
});
