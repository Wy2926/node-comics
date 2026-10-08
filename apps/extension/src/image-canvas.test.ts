import {afterEach, describe, expect, it, vi} from 'vitest';
import {createImageCanvas, imageCanvasBlob} from '../../../backend/shared/translation-images/canvas';
afterEach(() => vi.unstubAllGlobals());
describe('document canvas capability fallback', () => {
  it('retains the offscreen fast path and encoding options', async () => {
    const blob = new Blob(['fixture']), convertToBlob = vi.fn(async () => blob);
    vi.stubGlobal('OffscreenCanvas', class {constructor(readonly width:number, readonly height:number) {} convertToBlob = convertToBlob;});
    const canvas = createImageCanvas(240, 360);
    expect(canvas).toMatchObject({width:240, height:360});
    expect(await imageCanvasBlob(canvas, 'image/webp', .75)).toBe(blob);
    expect(convertToBlob).toHaveBeenCalledWith({type:'image/webp', quality:.75});
  });
  it('uses a native document canvas when offscreen rendering is unavailable', async () => {
    const blob = new Blob(['fixture']), toBlob = vi.fn((done:BlobCallback) => done(blob));
    const canvas = {width:0, height:0, toBlob};
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('document', {createElement:vi.fn(() => canvas)});
    expect(createImageCanvas(800, 1200)).toBe(canvas);
    expect(canvas).toMatchObject({width:800, height:1200});
    expect(await imageCanvasBlob(canvas as unknown as HTMLCanvasElement, 'image/png')).toBe(blob);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
  });
  it('does not publish empty bytes after native encoding fails', async () => {
    const canvas = {toBlob:(done:BlobCallback) => done(null)};
    await expect(imageCanvasBlob(canvas as HTMLCanvasElement, 'image/png')).rejects.toMatchObject({name:'EncodingError'});
  });
});
