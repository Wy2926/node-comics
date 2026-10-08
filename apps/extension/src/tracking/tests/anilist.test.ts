import {afterEach, describe, expect, it, vi} from 'vitest';
import {AniListProvider, TrackingError} from '../anilist';
import {createAniListRateLimit} from '../rate-limit';
import {createAniListProvider} from '../../discovery/anilist';

const rawEntry = (overrides = {}) => ({id: 8, mediaId: 12, userId: 7, progress: 4, status: 'CURRENT', ...overrides});
const rawMedia = (overrides = {}) => ({id: 12, idMal: 53, type: 'MANGA', format: 'MANGA', title: {userPreferred: 'Test'}, chapters: null, mediaListEntry: rawEntry(), ...overrides});
const provider = (fetcher: typeof fetch) => new AniListProvider({fetcher, rateLimit: createAniListRateLimit()});
afterEach(() => vi.unstubAllGlobals());

describe('AniList tracker protocol adapted from MALSync', () => {
  it('reads Viewer with bearer auth and never uses cookies or redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({data: {Viewer: {id: 7, name: 'Reader'}}}));
    expect(await provider(fetcher).viewer('private-token')).toEqual({id: 7, name: 'Reader'});
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('https://graphql.anilist.co');
    expect(request).toMatchObject({credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error'});
    expect(new Headers(request?.headers).get('Authorization')).toBe('Bearer private-token');
  });
  it('keeps MAL and AniList namespaces distinct and permits unknown ongoing totals', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({data: {Media: rawMedia()}}));
    const api = provider(fetcher);
    expect(await api.mediaByMalId(53, 'secret')).toMatchObject({id: 12, chapters: null, entry: {userId: 7}});
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).query).toContain('Media(idMal: $id, type: MANGA)');
    await expect(api.media(53, 'secret')).rejects.toMatchObject({code: 'identity'});
  });
  it('does not expose account/list fields or attach auth to public mapping search', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({data: {Page: {media: [rawMedia()]}}}))
      .mockResolvedValueOnce(Response.json({data: {Media: rawMedia()}}));
    const api = provider(fetcher);
    expect(await api.search('Test')).toEqual([{id: 12, title: 'Test', chapters: null, entry: null}]);
    expect((await api.media(12)).entry).toBeNull();
    for (const [, request] of fetcher.mock.calls) {
      expect(new Headers(request?.headers).has('Authorization')).toBe(false);
      expect(JSON.parse(String(request?.body)).query).not.toContain('mediaListEntry');
    }
  });
  it.each([{type: 'ANIME'}, {format: 'NOVEL'}, {chapters: 2.5}, {chapters: -1}, {mediaListEntry: undefined}])('rejects invalid manga/list metadata %j', async overrides => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({data: {Media: rawMedia(overrides)}}));
    await expect(provider(fetcher).media(12, 'token')).rejects.toMatchObject({code: 'invalid'});
  });
  it('updates an existing list entry with only its ID and progress', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({data: {SaveMediaListEntry: rawEntry()}}));
    await provider(fetcher).save({mediaId: 12, listEntryId: 8, progress: 4}, 'token');
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.variables).toEqual({id: 8, progress: 4});
    expect(body.query).not.toMatch(/score|notes|repeat|Volumes|status:|startedAt|completedAt/);
  });
  it('creates by media ID and explicitly changes only the permitted CURRENT status', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({data: {SaveMediaListEntry: rawEntry()}}));
    await provider(fetcher).save({mediaId: 12, progress: 4, status: 'CURRENT'}, 'token');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).variables).toEqual({mediaId: 12, progress: 4, status: 'CURRENT'});
  });
  it.each([{mediaId: 33}, {id: 22}, {progress: 3}, {status: 'BROKEN'}])('does not acknowledge a mismatched mutation %j', async overrides => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({data: {SaveMediaListEntry: rawEntry(overrides)}}));
    await expect(provider(fetcher).save({mediaId: 12, listEntryId: 8, progress: 4}, 'token')).rejects.toBeInstanceOf(TrackingError);
  });
  it('rejects fractions rather than truncating and refuses missing credentials before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = provider(fetcher);
    await expect(api.save({mediaId: 12, progress: 2.5}, 'token')).rejects.toMatchObject({code: 'invalid'});
    await expect(api.save({mediaId: 12, progress: 3}, '')).rejects.toMatchObject({code: 'auth'});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects partial GraphQL errors at HTTP 200 without leaking provider content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({data: {SaveMediaListEntry: rawEntry()}, errors: [{message: 'private-secret response'}]}))
      .mockResolvedValueOnce(Response.json({errors: [{status: 400, message: 'Invalid token'}]}));
    const api = provider(fetcher);
    await expect(api.save({mediaId: 12, progress: 4}, 'token')).rejects.toThrow('AniList invalid');
    await expect(api.viewer('token')).rejects.toThrow('AniList auth');
  });
  it.each([401, 403, 503])('classifies HTTP %s without the response body', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret echoed', {status}));
    await expect(provider(fetcher).viewer('token')).rejects.toMatchObject({code: status === 503 ? 'unavailable' : 'auth'});
  });
  it('masks network failures and aborts stalled requests after a bounded timeout', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private request details')));
    }));
    try {
      const attempt = expect(provider(fetcher).viewer('token')).rejects.toThrow('AniList unavailable');
      await vi.advanceTimersByTimeAsync(15_000);
      await attempt;
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
});

describe('shared AniList response-driven cooldown', () => {
  it('honors the later Retry-After/reset and shares tracker throttling with anonymous discovery', async () => {
    let now = 100_000;
    const rateLimit = createAniListRateLimit(() => now);
    const trackerFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {status: 429, headers: {'Retry-After': '12', 'X-RateLimit-Reset': '120'}}));
    const discoverFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({data: {Media: {id: 12, title: {native: 'Test'}}}}));
    const api = new AniListProvider({fetcher: trackerFetch, rateLimit});
    const discovery = createAniListProvider(discoverFetch, () => now, rateLimit);
    await expect(api.viewer('token')).rejects.toMatchObject({code: 'rate-limit', retryAt: 120_000});
    await expect(discovery.detail(12, new AbortController().signal)).rejects.toMatchObject({kind: 'rate-limit', retryAt: 120_000});
    expect(discoverFetch).not.toHaveBeenCalled();
    now = 120_001;
    await discovery.detail(12, new AbortController().signal);
    expect(new Headers(discoverFetch.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  });
  it('persists only a cooldown timestamp, including exhausted successful responses, for a restarted context', async () => {
    const storage: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {storage: {local: {get: async (key: string) => ({[key]: storage[key]}), set: async (value: object) => {Object.assign(storage, value);}}}});
    const rateLimit = createAniListRateLimit(() => 100_000, true);
    await rateLimit.observe(new Response(null, {headers: {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '150'}}));
    expect(await createAniListRateLimit(() => 101_000, true).availableAt()).toBe(150_000);
    expect(storage).toEqual({'nc-anilist-rate-limit-until': 150_000});
  });
  it('applies the documented fallback when 429 headers are absent or malformed', async () => {
    const rateLimit = createAniListRateLimit(() => 100_000);
    expect(await rateLimit.observe(new Response(null, {status: 429, headers: {'X-RateLimit-Reset': 'invalid'}}))).toBe(160_000);
  });
  it('does not treat GraphQL 429 at HTTP 200 as success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({errors: [{status: 429, message: 'Too Many Requests.'}]}));
    const api = new AniListProvider({fetcher, now: () => 100_000});
    await expect(api.viewer('token')).rejects.toMatchObject({code: 'rate-limit', retryAt: 160_000});
  });
});
