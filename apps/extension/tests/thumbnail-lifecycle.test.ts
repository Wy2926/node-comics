import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { thumbnailCache } from '../src/storage/thumbnails';
import { pageReference, RENDER_PROFILE } from '../src/comics/pages/identity';
const mocks = vi.hoisted(() => ({ acquire: vi.fn(), encode: vi.fn(), release: vi.fn(), close: vi.fn() }));
vi.mock('../src/comics/pages/service', () => ({ acquirePage: mocks.acquire }));
import { readThumbnail } from '../src/comics/application/image-access';
beforeEach(async () => {
  await thumbnailCache.clear(); mocks.acquire.mockReset().mockResolvedValue({ blob: new Blob(['original']), release: mocks.release });
  mocks.encode.mockReset().mockResolvedValue(new Blob(['thumbnail'])); mocks.release.mockClear(); mocks.close.mockClear();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 240, height: 360, close: mocks.close })));
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return { drawImage() {} }; } convertToBlob() { return mocks.encode(); } });
});
afterEach(() => vi.unstubAllGlobals());
const reference = () => { const entryId = crypto.randomUUID(); return { entryId, key: pageReference({ entryId, contentId: 'revision', pageId: 'page', renderProfileId: RENDER_PROFILE }) }; };
describe('thumbnail lifecycle fences', () => {
  it.each(['clear', 'delete'] as const)('returns decoded bytes without restoring the cache after %s', async action => {
    const ref = reference(), ready = Promise.withResolvers<void>(), encoded = Promise.withResolvers<Blob>();
    mocks.encode.mockImplementationOnce(() => { ready.resolve(); return encoded.promise; });
    const loading = readThumbnail(ref.key); await ready.promise;
    if (action === 'clear') await thumbnailCache.clear(); else await thumbnailCache.deleteOwner(ref.entryId, true);
    encoded.resolve(new Blob(['late-thumbnail'])); expect(await (await loading).text()).toBe('late-thumbnail');
    expect(await thumbnailCache.get(ref.key)).toBeUndefined(); expect(mocks.close).toHaveBeenCalledOnce(); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('still displays a thumbnail when the optional cache database is unavailable', async () => {
    const token = vi.spyOn(thumbnailCache, 'token').mockRejectedValueOnce(Error('Storage denied'));
    expect(await (await readThumbnail(reference().key)).text()).toBe('thumbnail'); token.mockRestore();
    expect((await thumbnailCache.usage()).count).toBe(0);
  });
});
