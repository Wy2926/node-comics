import {afterEach, expect, it, vi} from 'vitest';
const fixture = vi.hoisted(() => ({decode: vi.fn(), fetch: vi.fn()}));
vi.mock('../src/sources/registry/images', () => ({sourceImages: {fixture: {decodeInline: fixture.decode}}}));
vi.mock('../src/sources/registry/definitions', () => ({definitions: [{id: 'fixture', capabilities: {inline: true},
  identify: (url: URL) => url.hostname === 'fixture.test' ? {sourceId: 'fixture', kind: 'reader', url: url.href, pageKey: url.href} : null}]}));
vi.mock('../src/sources/runtime/image-fetch', () => ({fetchSourceImage: fixture.fetch}));
import {readInlineSourceImage} from '../src/sources/runtime/source-image';
afterEach(() => vi.resetAllMocks());
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
