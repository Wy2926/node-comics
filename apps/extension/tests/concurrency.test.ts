import {afterEach, describe, expect, it, vi} from 'vitest';
import {Api} from '../src/api';
import {normalizeConcurrency, RequestPool, StaleOperation} from '../src/concurrency';

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 1));
afterEach(() => vi.unstubAllGlobals());
describe('front-end request concurrency', () => {
  it('defaults to 2 and clamps stored values to integer 1–10', () => {
    expect([undefined, NaN, Infinity, '10'].map(normalizeConcurrency)).toEqual([2,2,2,2]);
    expect([0, 1, 3.7, 10, 99].map(normalizeConcurrency)).toEqual([1,1,3,10,10]);
  });
  it.each([1,2,5,10])('bounds original uploads at %i', async concurrency => {
    let active = 0, peak = 0;
    vi.stubGlobal('createImageBitmap', async () => ({close: () => {}}));
    vi.stubGlobal('fetch', async () => {
      active++;peak = Math.max(peak, active);await pause();active--;
      return new Response();
    });
    const api = new Api('https://api.example', 'token', new RequestPool(concurrency));
    await Promise.all(Array.from({length: 25}, () => api.uploadOriginal({id:'upload',url:'https://api.example/upload',method:'PUT',headers:{},expires_at:'2099-01-01'},new Blob(['a']))));
    expect(peak).toBe(concurrency);
  });
  it('defaults to five uploads while downloads and image access bypass occupied pools', async () => {
    let uploads = 0, downloads = 0, accesses = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    vi.stubGlobal('createImageBitmap', async () => ({close: () => {}}));
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith('/access')) {accesses++;await gate;return Response.json({url:'/result',expires_at:null});}
      if (path.endsWith('/upload')) {uploads++;await gate;return new Response();}
      downloads++;await gate;return new Response(new Blob(['image']));
    });
    const api = new Api('https://api.example');
    const pendingUploads = Array.from({length:12}, () => api.uploadOriginal({id:'upload',url:'https://api.example/upload',method:'PUT',headers:{},expires_at:'2099-01-01'},new Blob(['a'])));
    const pendingDownloads = Array.from({length:12}, (_, i) => api.image('image-'+i));
    await pause();
    try {expect(uploads).toBe(5);expect(accesses).toBe(12);} finally {release();}
    await Promise.all([...pendingUploads,...pendingDownloads]);
    expect(downloads).toBe(12);
  });
  it('starts every image download even while the upload pool is occupied', async () => {
    let release!: () => void;let downloads = 0;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const pool = new RequestPool(1);
    const occupied = pool.run(() => gate);
    vi.stubGlobal('createImageBitmap', async () => ({close: () => {}}));
    vi.stubGlobal('fetch', async (url: string | URL) => {
      if(String(url).endsWith('/access'))return Response.json({url:'/result',expires_at:null});
      downloads++;await gate;return new Response(new Blob(['image']));
    });
    const api = new Api('https://api.example','',pool);
    const images = Array.from({length:12}, (_,i) => api.image('image-'+i));
    await pause();
    try {expect(downloads).toBe(12);} finally {release();}
    await Promise.all([occupied,...images]);
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
