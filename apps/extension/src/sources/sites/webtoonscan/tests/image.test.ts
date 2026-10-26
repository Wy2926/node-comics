import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {sourceImages} from '../../../registry/images';
import {readInlineSourceImage, readSourceArtwork, readSourceCover, readSourceImage} from '../../../runtime/source-image';
import {parseCatalog} from '../network';
import {artwork, catalogHtml, image, reader, url} from './fixtures';

const fixture = vi.hoisted(() => ({page: vi.fn(), http: vi.fn(), message: vi.fn()}));
vi.mock('../../../runtime/page-cover', () => ({readPageCover: fixture.page}));
vi.mock('../../../runtime/image-fetch', () => ({fetchSourceImage: fixture.http}));
vi.mock('../../../runtime/client', () => ({sourceMessage: fixture.message}));

beforeEach(() => {
  fixture.page.mockReset().mockResolvedValue(new Blob(['cover']));
  fixture.http.mockReset().mockResolvedValue({blob: new Blob(['image'])});
  fixture.message.mockReset().mockResolvedValue({url: image, pageUrl: reader, sourceId: 'webtoonscan'});
  vi.stubGlobal('chrome', {permissions: {contains: vi.fn(async () => true)}});
});
afterEach(() => vi.unstubAllGlobals());

describe('WebtoonScan cover transport', () => {
  it('registers only the cover transport and routes catalog artwork through the image document', async () => {
    expect(sourceImages.webtoonscan).toEqual({coverTransport: 'page'});
    const signal = new AbortController().signal;
    expect(await (await readSourceCover(parseCatalog(catalogHtml(), url), signal)).text()).toBe('cover');
    expect(fixture.page).toHaveBeenCalledExactlyOnceWith(artwork, signal);
    expect(fixture.http).not.toHaveBeenCalled();
  });
  it('does not fall back to extension HTTP after a page-cover failure', async () => {
    fixture.page.mockRejectedValueOnce(Error('HTTP 403'));
    await expect(readSourceCover(parseCatalog(catalogHtml(), url))).rejects.toThrow('403');
    expect(fixture.page).toHaveBeenCalledOnce();
    expect(fixture.http).not.toHaveBeenCalled();
  });
  it('does not start a cancelled cover read', async () => {
    await expect(readSourceCover(parseCatalog(catalogHtml(), url), AbortSignal.abort(Error('cancelled')))).rejects.toThrow('cancelled');
    expect(fixture.page).not.toHaveBeenCalled();
    expect(fixture.http).not.toHaveBeenCalled();
  });
  it('keeps chapter and generic inline images on their existing HTTP paths', async () => {
    const progress=vi.fn();
    await readSourceImage({manifestId: 'fixture', pageId: 'image-0', expectedUrl: image},undefined,progress);
    await readInlineSourceImage(image, reader, undefined, 'origin');
    expect(fixture.http.mock.calls).toEqual([
      [image, undefined, undefined, {pageUrl: reader,safariTransport:undefined},progress],
      [image, undefined, undefined, {pageUrl: reader,safariTransport:undefined, referrerPolicy: 'origin'}],
    ]);
    expect(fixture.page).not.toHaveBeenCalled();
  });
  it('does not switch artwork from other sources to the page transport', async () => {
    await readSourceArtwork('generic', 'https://other.test/cover.png', 'https://other.test/book');
    expect(fixture.http).toHaveBeenCalledExactlyOnceWith('https://other.test/cover.png', undefined, undefined, {pageUrl: 'https://other.test/book'});
    expect(fixture.page).not.toHaveBeenCalled();
  });
});
