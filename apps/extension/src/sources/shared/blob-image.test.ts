import {afterEach, describe, expect, it, vi} from 'vitest';
import {readBlobImage} from './blob-image';
import {renderedImages} from './dom-images';

const pageUrl = 'https://example.test/read/1', url = 'blob:https://example.test/decoded';
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const draw = vi.fn(), encoded = new Blob(['decoded pixels'], {type: 'image/png'});
  const canvas = {width: 0, height: 0, getContext: () => ({drawImage: draw}),
    toBlob: vi.fn((done: (value: Blob) => void) => done(encoded))};
  const document = {defaultView: {location: {href: pageUrl}}, createElement: vi.fn(() => canvas), querySelectorAll: () => [image]};
  const image = {src: url, currentSrc: '', isConnected: true, complete: true, naturalWidth: 720, naturalHeight: 1020, ownerDocument: document};
  return {image: image as unknown as HTMLImageElement, document, canvas, draw, encoded};
}
describe('shared page-owned Blob acquisition', () => {
  it('preserves readable Blob bytes/encoding without allocating a canvas', async () => {
    const f = fixture(), blob = new Blob(['original jpeg'], {type: 'image/jpeg'});
    const fetcher = vi.fn(async () => new Response(blob)); vi.stubGlobal('fetch', fetcher);
    const result = await readBlobImage(f.image, url, pageUrl);
    expect(await result.text()).toBe('original jpeg'); expect(result.type).toBe('image/jpeg');
    expect(fetcher).toHaveBeenCalledOnce(); expect(f.document.createElement).not.toHaveBeenCalled();
  });
  it('recovers revoked Blob pixels at native size only when read, then releases canvas memory', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => {throw TypeError('revoked');}));
    f.canvas.toBlob.mockImplementation(done => {
      expect([f.canvas.width, f.canvas.height]).toEqual([720, 1020]); done(f.encoded);
    });
    const [target] = renderedImages(f.document as unknown as Document, pageUrl);
    expect(f.document.createElement).not.toHaveBeenCalled();
    expect(await target.read!()).toBe(f.encoded);
    expect(f.draw).toHaveBeenCalledExactlyOnceWith(f.image, 0, 0);
    expect(f.canvas.toBlob).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 'image/png');
    expect([f.canvas.width, f.canvas.height]).toEqual([0, 0]);
  });
  it.each(['detached', 'unloaded', 'changed-url', 'navigation', 'zero-width', 'foreign', 'http'])('rejects %s before fetch or canvas access', async mode => {
    const f = fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    let target = url;
    if (mode === 'detached') Object.assign(f.image, {isConnected: false});
    if (mode === 'unloaded') Object.assign(f.image, {complete: false});
    if (mode === 'changed-url') f.image.src = url + 'other';
    if (mode === 'navigation') f.document.defaultView.location.href = pageUrl + '/next';
    if (mode === 'zero-width') Object.assign(f.image, {naturalWidth: 0});
    if (mode === 'foreign') target = 'blob:https://foreign.test/decoded';
    if (mode === 'http') target = 'https://example.test/decoded';
    await expect(readBlobImage(f.image, target, pageUrl)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(f.draw).not.toHaveBeenCalled();
  });
  it.each(['abort', 'replace', 'resize', 'navigate'])('rejects %s during Blob fetch and does not export stale pixels', async mode => {
    const f = fixture(), controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (mode === 'abort') controller.abort();
      if (mode === 'replace') f.image.src = url + 'next';
      if (mode === 'resize') Object.assign(f.image, {naturalWidth: 1440});
      if (mode === 'navigate') f.document.defaultView.location.href = pageUrl + '/next';
      throw Error('expired');
    }));
    await expect(readBlobImage(f.image, url, pageUrl, controller.signal)).rejects.toThrow();
    expect(f.draw).not.toHaveBeenCalled();
  });
  it('rejects a stale successful fetch instead of returning another page', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => {f.image.src = url + 'next'; return new Response('bytes');}));
    await expect(readBlobImage(f.image, url, pageUrl)).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
    expect(f.draw).not.toHaveBeenCalled();
  });
  it('rejects source changes during encoding and releases the canvas on failure', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => {throw Error('revoked');}));
    f.canvas.toBlob.mockImplementation(done => {f.image.src = url + 'next'; done(f.encoded);});
    await expect(readBlobImage(f.image, url, pageUrl)).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
    expect([f.canvas.width, f.canvas.height]).toEqual([0, 0]);
  });
  it('does not bypass tainted image security', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => {throw Error('revoked');}));
    f.canvas.toBlob.mockImplementation(() => {throw Error('SecurityError');});
    await expect(readBlobImage(f.image, url, pageUrl)).rejects.toThrow();
    expect([f.canvas.width, f.canvas.height]).toEqual([0, 0]);
  });
  it('excludes malformed and foreign Blob URLs without failing other candidates', () => {
    const f = fixture(), images = [f.image, {...f.image, src: 'blob:bad'}, {...f.image, src: 'blob:https://foreign.test/a'}];
    const document = {...f.document, querySelectorAll: () => images} as unknown as Document;
    expect(renderedImages(document, pageUrl).map(t => t.element)).toEqual([f.image]);
  });
});
