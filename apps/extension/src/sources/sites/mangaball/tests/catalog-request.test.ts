import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createCatalogRequest} from '../catalog-request';

const limited = (retryAfter?: unknown) => Object.assign(new Error('MangaBall HTTP 429'), {kind: 'http', details: {status: 429, retryAfter}});
beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(0);});
afterEach(() => {vi.useRealTimers();});

describe('MangaBall catalog request pacing and bounded recovery', () => {
  it('starts immediately and spaces subsequent fast requests without delaying an already slow response', async () => {
    const starts: number[] = [];
    const request = createCatalogRequest({request: async () => {starts.push(Date.now()); return 'ok';}});
    await request('first');
    const second = request('second');
    await vi.advanceTimersByTimeAsync(499); expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1); await second; expect(starts).toEqual([0, 500]);
    await vi.advanceTimersByTimeAsync(800); await request('third');
    expect(starts).toEqual([0, 500, 1300]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('honors Retry-After seconds before retrying the same URL', async () => {
    const starts: number[] = [], urls: string[] = [];
    const request = createCatalogRequest({request: async url => {
      starts.push(Date.now()); urls.push(url);
      if (starts.length === 1) throw limited(3);
      return 'recovered';
    }});
    const result = request('failed-page');
    await vi.advanceTimersByTimeAsync(2999); expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1); expect(await result).toBe('recovered');
    expect(starts).toEqual([0, 3000]); expect(urls).toEqual(['failed-page', 'failed-page']);
  });
  it('limits retries to three backoffs and preserves the final transport error', async () => {
    const error = limited(), starts: number[] = [];
    const fetcher = vi.fn(async () => {starts.push(Date.now()); throw error;});
    const result = expect(createCatalogRequest({request: fetcher})('page')).rejects.toBe(error);
    await vi.runAllTimersAsync(); await result;
    expect(starts).toEqual([0, 1000, 3000, 7000]); expect(fetcher).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fails without an early retry when Retry-After exceeds the operation wait budget', async () => {
    const error = limited(31), fetcher = vi.fn(async () => {throw error;});
    await expect(createCatalogRequest({request: fetcher})('page')).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('shares the 30-second rate-limit wait budget across successful pages', async () => {
    const calls: string[] = [], error = limited(15), third = limited();
    const request = createCatalogRequest({request: async url => {
      calls.push(url);
      if (url === 'third') throw third;
      if (calls.filter(value => value === url).length === 1) throw error;
      return 'ok';
    }});
    const first = request('first'); await vi.runAllTimersAsync(); expect(await first).toBe('ok');
    const second = request('second'); await vi.runAllTimersAsync(); expect(await second).toBe('ok');
    const failed = expect(request('third')).rejects.toBe(third); await vi.runAllTimersAsync(); await failed;
    expect(calls).toEqual(['first', 'first', 'second', 'second', 'third']);
    expect(Date.now()).toBe(31000); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not infer rate limits from messages, coercible statuses, or non-HTTP failures', async () => {
    for (const error of [new Error('HTTP 429'), {details: {status: 429}}, Object.assign(new Error(), {status: 429, code: 429}),
      Object.assign(new Error(), {details: {status: '429'}}), Object.assign(new Error(), {details: [{status: 429}]}),
      Object.assign(new Error(), {kind: 'permission-required', details: {status: 429}}),
      Object.assign(new Error(), {kind: 'http', details: {status: 500}})]) {
      const fetcher = vi.fn(async () => {throw error;});
      await expect(createCatalogRequest({request: fetcher})('page')).rejects.toBe(error);
      expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    }
  });
  it('uses bounded backoff for malformed Retry-After values', async () => {
    for (const value of ['60', NaN, Infinity, -1, 0]) {
      const starts: number[] = [];
      const request = createCatalogRequest({request: async () => {
        starts.push(Date.now()); if (starts.length === 1) throw limited(value); return 'ok';
      }});
      const result = request('page'); await vi.runAllTimersAsync(); expect(await result).toBe('ok');
      expect(starts[1] - starts[0]).toBe(1000);
    }
  });
  it('cancels pacing and backoff promptly, removing their timers and future requests', async () => {
    for (const backoff of [false, true]) {
      const controller = new AbortController(), reason = new Error('cancelled');
      const fetcher = vi.fn(async () => {if (backoff) throw limited(); return 'ok';});
      const request = createCatalogRequest({request: fetcher, signal: controller.signal});
      if (!backoff) await request('completed');
      const pending = request('pending'), rejected = expect(pending).rejects.toBe(reason);
      await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(1);
      controller.abort(reason); await rejected;
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync(); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('checks cancellation before and after the HTTP transport', async () => {
    const controller = new AbortController(), reason = new Error('cancelled'), never = vi.fn();
    controller.abort(reason);
    await expect(createCatalogRequest({request: never, signal: controller.signal})('page')).rejects.toBe(reason);
    expect(never).not.toHaveBeenCalled();
    const inFlight = new AbortController();
    const request = createCatalogRequest({signal: inFlight.signal, request: async () => {inFlight.abort(reason); return 'discarded';}});
    await expect(request('page')).rejects.toBe(reason); expect(vi.getTimerCount()).toBe(0);
  });
});
