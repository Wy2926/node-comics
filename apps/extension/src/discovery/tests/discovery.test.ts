import {describe, expect, it, vi} from 'vitest';
import {createAniListProvider} from '../anilist';
import {DiscoverySession} from '../session';
import {defaultDiscoveryQuery, DiscoveryError, type DiscoveryDetail, type DiscoveryPageResult, type DiscoveryProvider, type DiscoveryWork} from '../types';

const raw = (id = 1) => ({id, title: {native: '作品', english: 'Work', romaji: 'Sakuhin'}, genres: ['Drama'], status: 'RELEASING', format: 'ONE_SHOT', averageScore: 90, coverImage: {large: 'https://s4.anilist.co/file/cover.jpg'}, startDate: {year: 2026}});
const work = (id = 1): DiscoveryWork => ({id, title: `Work ${id}`, titles: [`Work ${id}`], genres: [], url: `https://anilist.co/manga/${id}`});
const detail = (id = 1): DiscoveryDetail => ({...work(id), description: 'Description', contributors: []});
const page = (ids = [1], hasMore = false): DiscoveryPageResult => ({works: ids.map(work), hasMore});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
};
const signal = () => new AbortController().signal;

describe('AniList metadata boundary', () => {
  it('uses public GraphQL variables without account/source credentials and normalizes metadata', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({data: {Page: {pageInfo: {hasNextPage: true}, media: [raw()]}}}));
    const provider = createAniListProvider(fetcher);
    const result = await provider.list({...defaultDiscoveryQuery, search: '"quoted"', status: 'hiatus', year: '2025', country: 'JP', format: 'oneshot'}, 2, signal());
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('https://graphql.anilist.co');
    expect(request).toMatchObject({credentials: 'omit', referrerPolicy: 'no-referrer'});
    expect(new Headers(request?.headers).has('Authorization')).toBe(false);
    expect(JSON.parse(String(request?.body)).variables).toMatchObject({page: 2, search: '"quoted"', status: 'HIATUS', year: '2025%', country: 'JP', formats: ['ONE_SHOT']});
    expect(result).toMatchObject({hasMore: true, works: [{id: 1, status: 'releasing', format: 'oneshot', title: '作品', score: 90}]});
  });
  it('never treats metadata as a readable source and rejects unsafe cover URLs and malformed responses', async () => {
    const media = {...raw(), format: 'UNKNOWN', coverImage: {large: 'https://anilist.co.attacker.test/image'}};
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({data: {Page: {pageInfo: {hasNextPage: false}, media: [media]}}})).mockResolvedValueOnce(Response.json({data: {Page: {media: []}}}));
    const provider = createAniListProvider(fetcher);
    const result = (await provider.list(defaultDiscoveryQuery, 1, signal())).works[0];
    expect(result.cover).toBeUndefined();
    expect(result.format).toBeUndefined();
    await expect(provider.list(defaultDiscoveryQuery, 1, signal())).rejects.toMatchObject({kind: 'invalid'});
  });
  it('retains API cooldown across detail/list requests and honors Retry-After', async () => {
    let now = 100_000;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', {status: 429, headers: {'Retry-After': '12'}})).mockResolvedValueOnce(Response.json({data: {Media: {...raw(), description: '<b>Text</b><br>Next', synonyms: ['Work', '別名'], staff: {edges: []}}}}));
    const provider = createAniListProvider(fetcher, () => now);
    await expect(provider.list(defaultDiscoveryQuery, 1, signal())).rejects.toMatchObject({kind: 'rate-limit', retryAt: 112_000});
    await expect(provider.detail(1, signal())).rejects.toMatchObject({kind: 'rate-limit'});
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 112_001;
    expect(await provider.detail(1, signal())).toMatchObject({description: 'Text\nNext', titles: ['作品', 'Work', 'Sakuhin', '別名']});
  });
  it('rejects partial GraphQL errors and detail identity changes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({data: {Media: raw()}, errors: [{message: 'partial'}]})).mockResolvedValueOnce(Response.json({data: {Media: raw(2)}}));
    const provider = createAniListProvider(fetcher);
    await expect(provider.detail(1, signal())).rejects.toMatchObject({kind: 'unavailable'});
    await expect(provider.detail(1, signal())).rejects.toMatchObject({kind: 'invalid'});
  });
});

describe('Discovery session isolation and recovery', () => {
  it('does not fetch on construction; ignores late results and deduplicates repeated submit', async () => {
    const first = deferred<DiscoveryPageResult>(), second = deferred<DiscoveryPageResult>();
    const list = vi.fn<DiscoveryProvider['list']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const session = new DiscoverySession({genres: [], list, detail: vi.fn()});
    expect(list).not.toHaveBeenCalled();
    const old = session.search();
    await session.search();
    expect(list).toHaveBeenCalledTimes(1);
    const next = session.search({...defaultDiscoveryQuery, ranking: 'popular'});
    expect(list.mock.calls[0][2].aborted).toBe(true);
    second.resolve(page([2])); await next;
    first.resolve(page([1])); await old;
    expect(session.getSnapshot().works.map(value => value.id)).toEqual([2]);
  });
  it('keeps loaded pages on pagination failure and retries the failed page without duplicates', async () => {
    const list = vi.fn<DiscoveryProvider['list']>().mockResolvedValueOnce(page([1], true)).mockRejectedValueOnce(new DiscoveryError('unavailable')).mockResolvedValueOnce(page([1, 2]));
    const session = new DiscoverySession({genres: [], list, detail: vi.fn()});
    await session.search(); await session.more();
    expect(session.getSnapshot()).toMatchObject({page: 1, failedPage: 2, error: {kind: 'unavailable'}, works: [{id: 1}]});
    await session.more();
    expect(list).toHaveBeenCalledTimes(2);
    await session.retry();
    expect(list.mock.calls.map(call => call[1])).toEqual([1, 2, 2]);
    expect(session.getSnapshot().works.map(value => value.id)).toEqual([1, 2]);
    expect(session.getSnapshot().failedPage).toBeUndefined();
  });
  it('coalesces repeated pagination requests and stops at the final page', async () => {
    const next = deferred<DiscoveryPageResult>();
    const list = vi.fn<DiscoveryProvider['list']>().mockResolvedValueOnce(page([1], true)).mockReturnValueOnce(next.promise);
    const session = new DiscoverySession({genres: [], list, detail: vi.fn()});
    await session.search();
    const loading = session.more();
    await session.more();
    expect(list.mock.calls.map(call => call[1])).toEqual([1, 2]);
    next.resolve(page([2])); await loading;
    await session.more();
    expect(list).toHaveBeenCalledTimes(2);
  });
  it('reuses bounded session caches and shows stale results when revalidation fails', async () => {
    let now = 0;
    const list = vi.fn<DiscoveryProvider['list']>().mockResolvedValueOnce(page([1])).mockResolvedValueOnce(page([2])).mockRejectedValueOnce(new DiscoveryError('unavailable'));
    const session = new DiscoverySession({genres: [], list, detail: vi.fn()}, () => now);
    await session.search(); await session.search({...defaultDiscoveryQuery, ranking: 'score'});
    const staleStates: boolean[] = [];
    const unsubscribe = session.subscribe(() => staleStates.push(session.getSnapshot().stale));
    await session.search(defaultDiscoveryQuery);
    unsubscribe();
    expect(staleStates).not.toContain(true);
    expect(list).toHaveBeenCalledTimes(2);
    now = 6 * 60_000;
    await session.search();
    expect(session.getSnapshot()).toMatchObject({stale: true, works: [{id: 1}], error: {kind: 'unavailable'}});
  });
  it('retains all loaded pages when refreshing the first page fails', async () => {
    const list = vi.fn<DiscoveryProvider['list']>()
      .mockResolvedValueOnce(page([1], true)).mockResolvedValueOnce(page([2]))
      .mockRejectedValueOnce(new DiscoveryError('unavailable'));
    const session = new DiscoverySession({genres: [], list, detail: vi.fn()});
    await session.search(); await session.more();
    await session.search(defaultDiscoveryQuery, true);
    expect(session.getSnapshot()).toMatchObject({stale: true, failedPage: 1, works: [{id: 1}, {id: 2}]});
  });
  it('closed/replaced details cannot reopen or overwrite current work; disposal aborts requests', async () => {
    const first = deferred<DiscoveryDetail>(), second = deferred<DiscoveryDetail>();
    const load = vi.fn<DiscoveryProvider['detail']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const session = new DiscoverySession({genres: [], list: vi.fn(), detail: load});
    const old = session.select(work(1)), next = session.select(work(2));
    second.resolve(detail(2)); await next;
    first.resolve(detail(1)); await old;
    expect(session.getSnapshot().detail?.id).toBe(2);
    session.close(); await session.select(work(2));
    expect(load).toHaveBeenCalledTimes(2);
    session.dispose();
    expect(load.mock.calls[0][1].aborted).toBe(true);
  });
});
