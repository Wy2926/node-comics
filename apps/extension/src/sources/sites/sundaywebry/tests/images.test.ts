import {afterEach, expect, it, vi} from 'vitest';
import {image} from '../image';
import {decodeBaku, bakuDimensions} from '../../../shared/gigaviewer/image';
import {imageUrl} from './fixtures';
afterEach(() => vi.unstubAllGlobals());
it('preserves remainder pixels, transposes whole 8-aligned tiles and releases bitmaps', async () => {
  const bitmap = {width: 67, height: 99, close: vi.fn()}, drawImage = vi.fn(), output = new Blob(['png']);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.stubGlobal('OffscreenCanvas', class {getContext() {return {drawImage};} async convertToBlob() {return output;}});
  expect(await image.decode!(new Blob(), new Headers(), 'webry-baku:67:99')).toBe(output);
  expect(drawImage.mock.calls[0]).toEqual([bitmap, 0, 0]);
  expect(drawImage.mock.calls[2]).toEqual([bitmap, 16, 0, 16, 24, 0, 24, 16, 24]);
  expect(drawImage).toHaveBeenCalledTimes(17); expect(bitmap.close).toHaveBeenCalledOnce();
  expect(await image.decodeInline!(new Blob(), new Headers(), imageUrl)).toBe(output);
});
it('rejects malformed recipes, wrong dimensions and invalid inline hosts; cancellation never leaks bitmaps', async () => {
  const bitmap = {width: 67, height: 99, close: vi.fn()};
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  for (const value of ['unknown', 'webry-baku:0:10', 'webry-baku:9007199254740992:10']) expect(() => bakuDimensions(value, 'webry-baku')).toThrow();
  await expect(decodeBaku(new Blob(), {width: 68, height: 99})).rejects.toThrow(); expect(bitmap.close).toHaveBeenCalledOnce();
  await expect(image.decodeInline!(new Blob(), new Headers(), 'https://evil.test/image')).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(decodeBaku(new Blob(), undefined, controller.signal)).rejects.toThrow();
  expect(createImageBitmap).toHaveBeenCalledTimes(1);
});
it('restores valid large originals without a source pixel or edge ceiling', async () => {
  const bitmap = {width: 20001, height: 20001, close: vi.fn()}, drawImage = vi.fn(), output = new Blob(['png']);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.stubGlobal('OffscreenCanvas', class {getContext() {return {drawImage};} async convertToBlob() {return output;}});
  expect(await decodeBaku(new Blob(), {width: bitmap.width, height: bitmap.height})).toBe(output);
  expect(drawImage).toHaveBeenCalledTimes(17); expect(bitmap.close).toHaveBeenCalledOnce();
});
