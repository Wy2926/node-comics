import {describe, expect, it, vi} from 'vitest';
import {createGoogleTranslator, splitText} from '../adapters/google';
import {TextTranslationSession} from '../session';
import type {TextTranslationAdapter} from '../contracts';

const signal = () => new AbortController().signal;
const deferred = () => {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>(done => {resolve = done;});
  return {resolve, promise};
};
const tick = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};

describe('Anonymous Google text adapter', () => {
  it('sends metadata in a POST body with no credentials, redirects or source context', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([[['世界之间的', 'A'], ['书店。', 'bookshop']]]));
    const translator = createGoogleTranslator(fetcher);
    expect(await translator.translate('A bookshop', 'zh-CN', signal())).toBe('世界之间的书店。');
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/translate\.googleapis\.com\/translate_a\/single\?/);
    expect(new URL(String(url)).searchParams.get('q')).toBeNull();
    expect(init).toMatchObject({method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'});
    expect(String(init?.body)).toBe('q=A+bookshop');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });
  it('preserves long input and Unicode while requesting bounded chunks in sequence', async () => {
    const text = ('A long sentence with spaces.\n' + '😀'.repeat(100)).repeat(40);
    expect(splitText(text).join('')).toBe(text);
    expect(splitText(text).every(part => part.length <= 4001 && !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const part = (init?.body as URLSearchParams).get('q');
      return Response.json([[[part, part]]]);
    });
    expect(await createGoogleTranslator(fetcher).translate(text, 'en', signal())).toBe(text);
    expect(fetcher.mock.calls.length).toBe(splitText(text).length);
  });
  it('rejects malformed/oversized responses and input; retains provider cooldown', async () => {
    let now = 10_000;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', {status: 429, headers: {'Retry-After': '5'}}))
      .mockResolvedValueOnce(Response.json([[[null, 'Original']]]))
      .mockResolvedValueOnce(new Response('x'.repeat(524289)));
    const adapter = createGoogleTranslator(fetcher, () => now);
    await expect(adapter.translate('Title', 'en', signal())).rejects.toMatchObject({kind: 'rate-limit', retryAt: 15000});
    await expect(adapter.translate('Other', 'en', signal())).rejects.toMatchObject({kind: 'rate-limit'});
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 15001;
    await expect(adapter.translate('Title', 'en', signal())).rejects.toMatchObject({kind: 'invalid'});
    await expect(adapter.translate('Title', 'en', signal())).rejects.toMatchObject({kind: 'invalid'});
    await expect(adapter.translate('a'.repeat(16001), 'en', signal())).rejects.toMatchObject({kind: 'invalid'});
    await expect(adapter.translate('Title', 'en&key=x', signal())).rejects.toMatchObject({kind: 'invalid'});
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('stops long-text processing on cancellation and rejects a late response', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort(); return Response.json([[['Late', 'Original']]]);
    });
    await expect(createGoogleTranslator(fetcher).translate('Title'.repeat(1000), 'en', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps the longest cooldown from concurrent responses and stops subsequent chunks', async () => {
    const pending: ((response: Response) => void)[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => {pending.push(resolve);}));
    const adapter = createGoogleTranslator(fetcher, () => 10_000);
    const long = adapter.translate('x'.repeat(5000), 'en', signal()).catch(error => error);
    const short = adapter.translate('Title', 'en', signal()).catch(error => error);
    const concurrent = adapter.translate('Other', 'en', signal()).catch(error => error);
    expect(fetcher).toHaveBeenCalledTimes(3);
    pending[1](new Response('', {status: 429, headers: {'Retry-After': '600'}}));
    expect(await short).toMatchObject({kind: 'rate-limit', retryAt: 610_000});
    pending[2](new Response('', {status: 429, headers: {'Retry-After': '1'}}));
    expect(await concurrent).toMatchObject({kind: 'rate-limit', retryAt: 610_000});
    pending[0](Response.json([[['First chunk', 'Original']]]));
    expect(await long).toMatchObject({kind: 'rate-limit', retryAt: 610_000});
    await expect(adapter.translate('New', 'en', signal())).rejects.toMatchObject({kind: 'rate-limit', retryAt: 610_000});
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('Bounded text translation session', () => {
  it('uses two slots, shares exact input and cancels only after the last consumer leaves', async () => {
    const pending = Array.from({length: 3}, deferred);
    const translate = vi.fn<TextTranslationAdapter['translate']>().mockReturnValueOnce(pending[0].promise)
      .mockReturnValueOnce(pending[1].promise).mockReturnValueOnce(pending[2].promise);
    const session = new TextTranslationSession({id: 'fixture', name: 'Fixture', translate});
    const first = new AbortController(), second = new AbortController();
    const a = session.translate('A', 'en', first.signal).catch(error => error);
    const shared = session.translate('A', 'en', second.signal);
    const b = session.translate('B', 'en', signal()), c = session.translate('C', 'en', signal());
    await tick(); expect(translate).toHaveBeenCalledTimes(2);
    first.abort(); await a;
    expect(translate.mock.calls[0][2].aborted).toBe(false);
    pending[0].resolve('Translated A'); expect(await shared).toBe('Translated A');
    await tick(); expect(translate).toHaveBeenCalledTimes(3);
    pending[1].resolve('Translated B'); pending[2].resolve('Translated C'); await Promise.all([b, c]);
    expect(await session.translate('A', 'en', signal())).toBe('Translated A');
    expect(translate).toHaveBeenCalledTimes(3);
    session.dispose();
  });
  it('drops waiting jobs, prevents stale cache writes, and isolates languages', async () => {
    const pending = [deferred(), deferred()];
    const translate = vi.fn<TextTranslationAdapter['translate']>().mockReturnValueOnce(pending[0].promise)
      .mockReturnValueOnce(pending[1].promise).mockResolvedValue('New');
    const session = new TextTranslationSession({id: 'fixture', name: 'Fixture', translate});
    const tasks = ['A', 'B', 'C'].map(text => session.translate(text, 'en', signal()).catch(error => error));
    await tick(); session.cancel();
    expect((await Promise.all(tasks)).every(error => error.name === 'AbortError')).toBe(true);
    expect(translate.mock.calls.every(call => call[2].aborted)).toBe(true);
    pending.forEach(value => value.resolve('Late')); await tick();
    expect(translate).toHaveBeenCalledTimes(2);
    expect(await session.translate('A', 'en', signal())).toBe('New');
    expect(await session.translate('A', 'fr', signal())).toBe('New');
    expect(translate).toHaveBeenCalledTimes(4);
  });
  it('bounds the cache and retries failures only when requested', async () => {
    const translate = vi.fn<TextTranslationAdapter['translate']>().mockRejectedValueOnce(Error('Offline')).mockResolvedValue('Translated');
    const session = new TextTranslationSession({id: 'fixture', name: 'Fixture', translate});
    await expect(session.translate('Fail', 'en', signal())).rejects.toThrow('Offline');
    expect(await session.translate('Fail', 'en', signal())).toBe('Translated');
    for (let i = 0; i < 121; i++) {await session.translate('Title ' + i, 'en', signal()); await tick();}
    await session.translate('Fail', 'en', signal());
    expect(translate).toHaveBeenCalledTimes(124);
  });
});
