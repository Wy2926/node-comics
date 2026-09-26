import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollSourceDiscovery } from '../../../core/discovery';
import { createSourceNavigation, discoverDocument } from '../../../page';
import { sourceFailure } from '../../../runtime/diagnostics';
import { readMangaCopyData } from '../data';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const snapshot = (count: number, total = 6) => ({
  items: Array.from({ length: count }, (_, n) => ({
    id: 'slot-' + n,
    url: 'https://images.example/' + n,
    width: 800,
    height: 1200,
    order: n,
  })),
  knownTotal: total,
  discoveryComplete: count === total,
  note: `已发现 ${count} / ${total} 页`,
});
function documentFixture(urls: string[], total: number, script = '') {
  const images = urls.map((url) => ({
    getAttribute: (name: string) => (name === 'data-src' ? url : 'placeholder.png'),
    naturalWidth: 165,
    naturalHeight: 211,
    getBoundingClientRect: () => ({ top: 30 }),
  }));
  return {
    title: 'MangaCopy sample',
    querySelectorAll: (selector: string) =>
      selector === 'script:not([src])' ? (script ? [{ textContent: script }] : []) : images,
    querySelector: (selector: string) =>
      selector === '.comicCount'
        ? { textContent: String(total) }
        : selector === '.comicContent-list img'
          ? images[0]
          : {},
  } as unknown as Document;
}
const sourceUrl = 'https://www.mangacopy.com/comic/sample/chapter/724f819b-5306-11ea-b7ea-024352452ce0';
async function sourceData(value: unknown) {
  const secret = '0123456789abcdef',
    iv = 'abcdefghijklmnop',
    encoder = new TextEncoder();
  const aes = await crypto.subtle.importKey('raw', encoder.encode(secret), 'AES-CBC', false, ['encrypt']);
  const bytes = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: encoder.encode(iv) },
    aes,
    encoder.encode(JSON.stringify(value)),
  );
  return `var cct = "${secret}"; var contentKey = "${iv}${Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('')}";`;
}

describe('MangaCopy source discovery', () => {
  it('keeps missing lazy slots partial and preserves the prefix page order', () => {
    const result = discoverDocument(
      documentFixture(['https://images.example/1', '', 'https://images.example/3'], 3),
      'https://www.mangacopy.com/comic/a/chapter/724f819b-5306-11ea-b7ea-024352452ce0',
    );
    expect(result.discoveryComplete).toBe(false);
    expect(result.items.map((p) => p.id)).toEqual(['slot-0']);
    expect(result.items[0]).toMatchObject({ width: 800, height: 1200 });
  });
  it('decodes the full JS array in source order while only the initial DOM prefix exists', async () => {
    const urls = [
      'https://images.example/9',
      'https://images.example/2',
      'https://images.example/2',
      'https://second-cdn.example/1',
    ];
    const script = await sourceData(urls.map((url) => ({ url })));
    const doc = documentFixture(urls.slice(0, 1), 4, script);
    const result = await readMangaCopyData(doc, sourceUrl);
    expect(result).toMatchObject({ discoveryComplete: true, knownTotal: 4 });
    expect(result.items.map((p) => (p.resource.kind === 'http' ? p.resource.url : undefined))).toEqual(urls);
    expect(result.items.map((p) => p.id)).toEqual(['slot-0', 'slot-1', 'slot-2', 'slot-3']);
    expect(doc.querySelectorAll('.comicContent-list img')).toHaveLength(1);
  });
  it('rejects a mismatched total or a changed visible page order', async () => {
    const script = await sourceData([
      { url: 'https://images.example/1' },
      { url: 'https://images.example/2' },
    ]);
    await expect(
      readMangaCopyData(documentFixture(['https://images.example/1'], 3, script), sourceUrl),
    ).rejects.toThrow('SOURCE_TOTAL_MISMATCH');
    await expect(
      readMangaCopyData(documentFixture(['https://images.example/2'], 2, script), sourceUrl),
    ).rejects.toThrow('SOURCE_PAGE_ORDER_MISMATCH');
  });
  it.each(
    [
      [{ url: 'javascript:alert(1)' }],
      [{ url: 'https://user:pass@images.example/1' }],
      [{}],
      [],
      { url: 'https://images.example/1' },
    ].map((value) => ({ value })),
  )('rejects invalid decrypted entries %#', async ({ value }) => {
    await expect(
      readMangaCopyData(documentFixture([], 0, await sourceData(value)), sourceUrl),
    ).rejects.toThrow(/SOURCE_(PAGES|IMAGE_URL)_INVALID/);
  });
  it('does not execute inline JS and redacts malformed encrypted data errors', async () => {
    const doc = documentFixture(
      [],
      2,
      'var cct="0123456789abcdef"; var contentKey="abcdefghijklmnopprivate-invalid-data"; throw Error("must not run");',
    );
    await expect(readMangaCopyData(doc, sourceUrl)).rejects.toThrow('SOURCE_DATA_FORMAT');
    const invalid = 'var cct="0123456789abcdef"; var contentKey="abcdefghijklmnop' + '00'.repeat(16) + '";';
    await expect(readMangaCopyData(documentFixture([], 2, invalid), sourceUrl)).rejects.toThrow(
      'SOURCE_DATA_DECODE',
    );
  });
  it.each([
    { urls: ['https://images.example/1'], total: 3, code: 'SOURCE_TOTAL_MISMATCH', message: '总页数不一致' },
    { urls: ['https://images.example/2'], total: 2, code: 'SOURCE_PAGE_ORDER_MISMATCH', message: '图片顺序' },
  ])(
    'preserves $code through the public session and localized response',
    async ({ urls, total, code, message }) => {
      const script = await sourceData([
        { url: 'https://images.example/1' },
        { url: 'https://images.example/2' },
      ]);
      const navigation = createSourceNavigation(documentFixture(urls, total, script));
      const result = await navigation.get(sourceUrl).session.discoverPages();
      expect(result).toEqual({ status: 'error', code });
      expect(sourceFailure(Error(code)).error).toContain(message);
      navigation.dispose();
    },
  );
  it('returns the first known links immediately for preflight without scrolling or claiming completion', async () => {
    const doc = documentFixture(['https://images.example/1'], 10);
    const result = await pollSourceDiscovery(() => readMangaCopyData(doc, sourceUrl), {
      isComplete: (manifest) => manifest.items.length > 0,
    });
    expect(result.items).toHaveLength(1);
    expect(result.discoveryComplete).toBe(false);
  });
  it('keeps polling slow incremental manifests until the trusted total matches', async () => {
    vi.useFakeTimers();
    let count = 0;
    const progress = vi.fn(async () => {}),
      poll = vi.fn(async () => snapshot(Math.min(6, ++count)));
    const result = pollSourceDiscovery(poll, { onProgress: progress });
    await vi.advanceTimersByTimeAsync(1500);
    expect((await result).items).toHaveLength(6);
    expect(progress).toHaveBeenCalledTimes(6);
  });
  it('checks pause even when the page has stopped yielding new links', async () => {
    vi.useFakeTimers();
    let checks = 0;
    const poll = vi.fn(async () => snapshot(1));
    const result = pollSourceDiscovery(poll, {
      assertActive: async () => {
        if (++checks === 3) throw Error('已暂停');
      },
    });
    const assertion = expect(result).rejects.toThrow('已暂停');
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(poll).toHaveBeenCalledTimes(1);
  });
  it('reports a bounded actionable incomplete result instead of declaring success', async () => {
    vi.useFakeTimers();
    const result = pollSourceDiscovery(async () => snapshot(3));
    const assertion = expect(result).rejects.toThrow('40 秒未发现新图片');
    await vi.advanceTimersByTimeAsync(41000);
    await assertion;
  });
  it('aborts pending polling without waiting for the inactivity deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = pollSourceDiscovery(async () => null, { signal: controller.signal });
    const assertion = expect(result).rejects.toThrow('停止');
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(Error('停止'));
    await assertion;
  });

});
