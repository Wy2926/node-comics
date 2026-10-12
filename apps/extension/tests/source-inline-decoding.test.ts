import {afterEach, expect, it, vi} from 'vitest';
const fixture = vi.hoisted(() => ({decode: vi.fn(), fetch: vi.fn(), generic: false, inline: true}));
vi.mock('../src/sources/registry/images', () => ({sourceImages: {fixture: {decodeInline: fixture.decode}}}));
vi.mock('../src/sources/registry/definitions', () => ({definitions: [{id: 'fixture',
  get inlineRecognition() {return fixture.generic ? 'generic' : undefined;},
  capabilities: {get inline() {return fixture.inline;}},
  identify: (url: URL) => url.hostname === 'fixture.test' ? {sourceId: 'fixture',
    kind: url.pathname === '/catalog' ? 'catalog' : url.pathname === '/other' ? 'other' : 'reader', url: url.href, pageKey: url.href} : null}]}));
vi.mock('../src/sources/runtime/image-fetch', () => ({fetchSourceImage: fixture.fetch}));
import {readInlineSourceImage} from '../src/sources/runtime/source-image';
afterEach(() => {vi.resetAllMocks(); fixture.generic = false; fixture.inline = true;});
it.each(['catalog', 'other'])('allows generic HTTP originals on %s pages without relaxing custom recognition or URL checks', async kind => {
  const url = 'https://images.test/a', pageUrl = 'https://fixture.test/' + kind, blob = new Blob(['pixels']);
  fixture.fetch.mockResolvedValue({blob, headers: new Headers()}); fixture.decode.mockResolvedValue(blob);
  await expect(readInlineSourceImage(url, pageUrl)).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
  expect(fixture.fetch).not.toHaveBeenCalled();
  fixture.generic = true;
  expect(await readInlineSourceImage(url, pageUrl)).toBe(blob);
  expect(fixture.fetch).toHaveBeenCalledOnce();
  await expect(readInlineSourceImage('file:///a', pageUrl)).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
  fixture.inline = false;
  await expect(readInlineSourceImage(url, pageUrl)).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
  expect(fixture.fetch).toHaveBeenCalledOnce();
});
it('decodes HTTP canvas originals only through the resolved source, preserving cancellation and transport failures', async () => {
  const input = new Blob(['encoded']), output = new Blob(['decoded']), headers = new Headers();
  fixture.fetch.mockResolvedValue({blob: input, headers}); fixture.decode.mockResolvedValue(output);
  const signal = new AbortController().signal;
  expect(await readInlineSourceImage('https://images.test/a', 'https://fixture.test/read', signal)).toBe(output);
  expect(fixture.decode).toHaveBeenCalledExactlyOnceWith(input, headers, 'https://images.test/a', signal);
  const controller = new AbortController();
  fixture.decode.mockImplementation(async () => {controller.abort(); return output;});
  await expect(readInlineSourceImage('https://images.test/a', 'https://fixture.test/read', controller.signal)).rejects.toThrow();
  fixture.fetch.mockRejectedValueOnce(Error('denied'));
  await expect(readInlineSourceImage('https://images.test/a', 'https://fixture.test/read')).rejects.toThrow('denied');
  expect(fixture.decode).toHaveBeenCalledTimes(2);
});
