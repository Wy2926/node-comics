import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readInlineSourceImage, readSourceCover, readSourceImage } from '../../../runtime/source-image';
import type { SourceCatalogSnapshot } from '../../../contracts/source';
const fixture = vi.hoisted(() => ({ headers: [] as Record<string, string>[], message: vi.fn(), cover: vi.fn() }));
vi.mock('../../../runtime/client', () => ({ sourceMessage: fixture.message }));
vi.mock('../../../runtime/page-cover', () => ({ readPageCover: fixture.cover }));
vi.mock('../../../runtime/image-headers', () => ({
  withImageHeaders: async (_url: string, headers: Record<string, string>, _signal: AbortSignal, read: () => Promise<unknown>) => {
    fixture.headers.push(headers);
    return read();
  }
}));
const chapter = 'https://comix.to/title/nr83-the-sword-bearing-flower/11372843-chapter-60';
const url = 'https://images.wowpic2.store/fixture.webp';
const reference = { manifestId: 'fixture', pageId: 'page-0', expectedUrl: url };
beforeEach(() => {
  fixture.headers = [];
  fixture.message.mockReset().mockResolvedValue({ url, pageUrl: chapter, sourceId: 'comix' });
  fixture.cover.mockReset().mockResolvedValue(new Blob(['cover']));
  vi.stubGlobal('chrome', { permissions: { contains: vi.fn(async () => true) } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('image')));
});
afterEach(() => vi.unstubAllGlobals());
describe('Comix imported image Referer policy', () => {
  it('omits Referer for imported chapter images', async () => {
    expect(await (await readSourceImage(reference)).text()).toBe('image');
    expect(fixture.headers).toEqual([{}]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ referrerPolicy: 'no-referrer' }));
  });
  it('reads imported covers through the explicitly selected image-document transport', async () => {
    const cover = 'https://static.comix.to/fixture.jpg';
    const snapshot: SourceCatalogSnapshot = {
      id: 'comix:nr83', sourceId: 'comix', url: chapter.split('/11372843')[0],
      title: 'Fixture', observedAt: 1, complete: true, note: '', groups: [], entries: [], cover: { url: cover }
    };
    expect(await (await readSourceCover(snapshot)).text()).toBe('cover');
    expect(fixture.cover).toHaveBeenCalledExactlyOnceWith(cover, undefined);
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.headers).toEqual([]);
  });
  it('retains no-referrer across same-origin and cross-origin redirects', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next.webp' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://other-cdn.test/image.webp' } }));
    await readSourceImage(reference);
    expect(fixture.headers).toEqual([{}, {}, {}]);
    expect(chrome.permissions.contains).toHaveBeenLastCalledWith({ origins: ['https://other-cdn.test/*'] });
  });
  it('accepts an adapter-validated cover on a new CDN without another host declaration', async () => {
    const cover = 'https://new-cdn.test/cover.jpg';
    const snapshot: SourceCatalogSnapshot = {
      id: 'comix:nr83', sourceId: 'comix', url: chapter.split('/11372843')[0],
      title: 'Fixture', observedAt: 1, complete: true, note: '', groups: [], entries: [], cover: { url: cover },
    };
    expect(await (await readSourceCover(snapshot)).text()).toBe('cover');
    expect(fixture.cover).toHaveBeenCalledExactlyOnceWith(cover, undefined);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not override the live inline page policy', async () => {
    await readInlineSourceImage(url, chapter, undefined, 'origin');
    expect(fixture.headers).toEqual([{ referer: 'https://comix.to/' }]);
  });
  it('does not change other imported sources', async () => {
    fixture.message.mockResolvedValue({ url, pageUrl: 'https://reader.test/chapter' });
    await readSourceImage(reference);
    expect(fixture.headers).toEqual([{ referer: 'https://reader.test/' }]);
  });
  it('does not retry a failed request with Referer', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('denied', { status: 403 }));
    await expect(readSourceImage(reference)).rejects.toThrow('403');
    expect(fixture.headers).toEqual([{}]);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
