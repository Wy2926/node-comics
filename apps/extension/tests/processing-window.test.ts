import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ProcessingProfile} from '../src/image-processing/contracts';
const enhance = vi.hoisted(() => vi.fn());
vi.mock('../src/image-processing/runtime', () => ({enhanceImage: enhance}));
import {ProcessingWindow, type ProcessingTarget} from '../src/image-processing/window';

const profile: ProcessingProfile = {id: 'local', revision: 1, name: 'Local', adapterId: 'nunif', settings: {url: 'http://localhost/'}};
const target = (id: number): ProcessingTarget => ({id: String(id), sourceKey: 'source:' + id,
  input: {owner: 'book', key: 'result:' + id, validate: vi.fn(), load: vi.fn()}});
const targets = (...ids: number[]) => ids.map(target);
const requests = () => enhance.mock.calls.map(([input]) => input.key);
let window: ProcessingWindow;
beforeEach(() => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
  enhance.mockReset().mockResolvedValue(new Blob(['enhanced']));
  window = new ProcessingWindow(vi.fn());
});
afterEach(() => {window.clear(); vi.useRealTimers();});

describe('headless enhancement reading window', () => {
  it('starts the current image immediately and the next three after the shared warmup, without display reads', async () => {
    const pages = targets(0, 1, 2, 3);
    window.update(pages, profile, undefined, true);
    expect(requests()).toEqual(['result:0']);
    await vi.advanceTimersByTimeAsync(149);
    expect(requests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests()).toEqual(['result:0', 'result:1', 'result:2', 'result:3']);
    for (const page of pages) {
      expect(page.input!.load).not.toHaveBeenCalled();
      expect(window.image(page, profile)?.state?.phase).toBe('ready');
    }
  });

  it('adds the fifth slot without restarting warmup and caps arbitrary input to five', async () => {
    window.update(targets(0, 1, 2, 3), profile);
    await vi.advanceTimersByTimeAsync(50);
    window.update(targets(0, 1, 2, 3, 4, 5), profile);
    await vi.advanceTimersByTimeAsync(100);
    expect(requests()).toEqual(['result:0', 'result:1', 'result:2', 'result:3', 'result:4']);
  });

  it('keeps the actual reading anchor while some translations are incomplete', async () => {
    window.update([{id: '0'}, target(1), {id: '2'}, target(3)], profile);
    expect(enhance).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(requests()).toEqual(['result:1', 'result:3']);
    window.update(targets(0, 1, 2, 3), profile);
    expect(requests()).toEqual(['result:1', 'result:3', 'result:0', 'result:2']);
  });

  it('cancels departed work and submits only the latest jump after its own warmup', async () => {
    enhance.mockImplementation(() => new Promise(() => {}));
    window.update(targets(0, 1, 2, 3), profile);
    const signal = enhance.mock.calls[0][2] as AbortSignal;
    await vi.advanceTimersByTimeAsync(40);
    window.update(targets(10, 11, 12, 13), profile, undefined, true);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    window.update(targets(20, 21, 22, 23), profile, undefined, true);
    await vi.advanceTimersByTimeAsync(149);
    expect(requests()).toEqual(['result:0', 'result:10', 'result:20']);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests()).toEqual(['result:0', 'result:10', 'result:20', 'result:21', 'result:22', 'result:23']);
  });

  it('retains prefetched failures on navigation and retries only the chosen enhancement', async () => {
    enhance.mockImplementation(async input => {if (input.key === 'result:1') throw Error('Prefetch failed'); return new Blob(['ok']);});
    window.update(targets(0, 1, 2, 3), profile);
    await vi.advanceTimersByTimeAsync(150);
    window.update(targets(1, 2, 3, 4), profile);
    await vi.advanceTimersByTimeAsync(80);
    const failed = window.image(target(1), profile)!;
    expect(failed.state).toEqual({phase: 'error', message: 'Prefetch failed'});
    expect(requests()).toEqual(['result:0', 'result:1', 'result:2', 'result:3', 'result:4']);
    enhance.mockResolvedValue(new Blob(['recovered'])); failed.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(enhance.mock.lastCall?.[3].retry).toBe(true);
    expect(window.image(target(1), profile)?.state?.phase).toBe('ready');
  });

  it('ignores late results after identity changes or disable', async () => {
    const delayed = Promise.withResolvers<Blob>();
    enhance.mockReturnValueOnce(delayed.promise);
    window.update(targets(0), profile);
    expect(window.image(target(0), profile)?.blob).toBeUndefined();
    const signal = enhance.mock.calls[0][2] as AbortSignal;
    const next = {...target(0), sourceKey: 'replaced-source'};
    window.update([next], profile);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const current = window.image(next, profile)?.blob;
    delayed.resolve(new Blob(['stale'])); await vi.advanceTimersByTimeAsync(0);
    expect(window.image(next, profile)?.blob).toBe(current);
    window.update([next]);
    expect(window.image(next)).toBeUndefined();
    expect((enhance.mock.lastCall?.[2] as AbortSignal).aborted).toBe(true);
  });

  it('does not restart for profile labels but invalidates changed processing settings', async () => {
    window.update(targets(0), profile); await vi.advanceTimersByTimeAsync(0);
    const stale = window.image(target(0), profile)!;
    window.update(targets(0), {...profile, name: 'Renamed'});
    expect(enhance).toHaveBeenCalledTimes(1);
    window.update(targets(0), {...profile, revision: 2});
    expect(enhance).toHaveBeenCalledTimes(2);
    stale.retry(); expect(enhance).toHaveBeenCalledTimes(2);
    window.update(targets(0), {...profile, revision: 2}, 'cleared');
    expect(enhance).toHaveBeenCalledTimes(3);
  });

  it('distinguishes cache lookup from a miss using runtime state, without loading parents for display', async () => {
    const delayed = Promise.withResolvers<Blob>(), page = target(0);
    enhance.mockReturnValueOnce(delayed.promise);
    window.update([page], profile);
    expect(window.image(page, profile)?.state).toBeUndefined();
    const options = enhance.mock.lastCall![3];
    expect(options.onParent).toBeUndefined();
    for (const phase of ['queued', 'running'] as const) {
      options.onState({phase});
      expect(window.image(page, profile)).toMatchObject({state: {phase}});
      expect(window.image(page, profile)?.blob).toBeUndefined();
    }
    delayed.reject(Error('Service failed')); await vi.advanceTimersByTimeAsync(0);
    expect(window.image(page, profile)).toMatchObject({state: {phase: 'error', message: 'Service failed'}});
    expect(page.input!.load).not.toHaveBeenCalled();
  });

  it('cancels pending lookahead when hidden or closed without starting another request', async () => {
    window.update(targets(0, 1, 2, 3), profile);
    window.update(targets(0, 1, 2, 3));
    expect((enhance.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(requests()).toEqual(['result:0']);
    window.update(targets(10, 11, 12, 13), profile, undefined, true);
    window.clear(); await vi.advanceTimersByTimeAsync(200);
    expect(requests()).toEqual(['result:0', 'result:10']);
  });
});
