import {afterEach, expect, it, vi} from 'vitest';
import {decodeImage, parseProcessing} from '../images';
const processing = 'comici-v1:720:1024:' + Array.from({length: 16}, (_, i) => 15 - i).join(',');
afterEach(() => vi.unstubAllGlobals());
it('rejects malformed permutations before decoding', async () => {
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
  await expect(decodeImage(new Blob(), new Headers(), 'comici-v1:720:1024:0,0')).rejects.toThrow();
  expect(decode).not.toHaveBeenCalled();
  expect(() => parseProcessing(processing.replace('720', '20001'))).toThrow();
});
it('restores column-major tiles at original dimensions and closes decoded resources', async () => {
  const bitmap = {width: 720, height: 1024, close: vi.fn()}, drawImage = vi.fn(), output = new Blob(['png']);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.stubGlobal('OffscreenCanvas', class {getContext() {return {drawImage};} async convertToBlob() {return output;}});
  expect(await decodeImage(new Blob(), new Headers(), processing)).toBe(output);
  expect(drawImage).toHaveBeenCalledTimes(16);
  expect(drawImage.mock.calls[0]).toEqual([bitmap, 540, 768, 180, 256, 0, 0, 180, 256]);
  expect(drawImage.mock.calls[1]).toEqual([bitmap, 540, 512, 180, 256, 0, 256, 180, 256]);
  expect(bitmap.close).toHaveBeenCalledOnce();
});
it('rejects decoded dimension mismatch and closes the bitmap', async () => {
  const bitmap = {width: 721, height: 1024, close: vi.fn()};
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  await expect(decodeImage(new Blob(), new Headers(), processing)).rejects.toThrow('尺寸');
  expect(bitmap.close).toHaveBeenCalledOnce();
});
