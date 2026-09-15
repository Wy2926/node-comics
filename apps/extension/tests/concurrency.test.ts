import {afterEach, describe, expect, it, vi} from 'vitest';
import {Api} from '../src/api';
import {mapConcurrent, normalizeConcurrency, RequestPool, StaleOperation} from '../src/concurrency';

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 1));
afterEach(() => vi.unstubAllGlobals());
describe('front-end request concurrency', () => {
  it('defaults to 2 and clamps stored values to integer 1–10', () => {
    expect([undefined, NaN, Infinity, '10'].map(normalizeConcurrency)).toEqual([2,2,2,2]);
    expect([0, 1, 3.7, 10, 99].map(normalizeConcurrency)).toEqual([1,1,3,10,10]);
  });
  it.each([1,2,10])('bounds actual upload and result download requests together at %i', async concurrency => {
    let active = 0, peak = 0;
    const calls: string[] = [];
    vi.stubGlobal('createImageBitmap', async () => ({close: () => {}}));
    vi.stubGlobal('fetch', async (url: string | URL) => {
      calls.push(String(url));active++;peak = Math.max(peak, active);await pause();active--;
      if (String(url).endsWith('/access')) return Response.json({url: '/result', expires_at: ''});
      return String(url).endsWith('/result') ? new Response(new Blob(['image'])) : Response.json({id: 'asset'});
    });
    const api = new Api('https://api.example', 'token', new RequestPool(concurrency));
    await Promise.all(Array.from({length: 25}, (_, i) => i % 2 ? api.uploadOriginal({id:'upload',url:'https://api.example/upload',method:'PUT',headers:{},expires_at:'2099-01-01'},new Blob(['a'])) : api.image(`result-${i}`)));
    expect(peak).toBe(concurrency);expect(calls.some(url => url.endsWith('/result'))).toBe(true);
  });
  it('allows later pages to finish after one page fails and keeps selection order', async () => {
    const finished: number[] = [];
    const results = await mapConcurrent([0,1,2,3], 2, async i => {await pause();if(i===1)throw Error('unavailable');finished.push(i);return i;});
    expect(results.map(result => result.status)).toEqual(['fulfilled','rejected','fulfilled','fulfilled']);
    expect(finished.sort()).toEqual([0,2,3]);
  });
  it('applies a lower limit without cancelling in-flight requests or starting extra ones', async () => {
    const pool = new RequestPool(2);const release: (() => void)[] = [];const started: number[] = [];
    const jobs = [0,1,2,3].map(i => pool.run(async () => {started.push(i);await new Promise<void>(resolve => release.push(resolve));}));
    await pause();expect(started).toEqual([0,1]);pool.setLimit(1);
    release[0]();await pause();expect(started).toEqual([0,1]);
    release[1]();await pause();expect(started).toEqual([0,1,2]);
    release[2]();await pause();release[3]();await Promise.all(jobs);
  });
  it('does not dispatch queued account requests after the session changes', async () => {
    const pool = new RequestPool(1);let release!: () => void;let current = true;
    const blocking = pool.run(() => new Promise<void>(resolve => {release=resolve;}));await pause();
    const fetch = vi.fn();vi.stubGlobal('fetch', fetch);
    const api = new Api('https://api.example', 'old-token', pool, () => current);
    const request = api.uploadOriginal({id:'upload',url:'https://api.example/upload',method:'PUT',headers:{},expires_at:'2099-01-01'},new Blob(['a'])).catch(error => error);
    current=false;release();await blocking;expect(await request).toBeInstanceOf(StaleOperation);expect(fetch).not.toHaveBeenCalled();
  });
});
