import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {TrackingView} from '../../tracking/client';

// Exercise the actual hook's async ordering without introducing a DOM dependency.
const hooks = vi.hoisted(() => ({
  state: 0, ref: 0, memo: 0, effect: 0, dirty: false,
  states: [] as unknown[], refs: [] as {current: unknown}[],
  memos: [] as {value: unknown; deps: unknown[]}[],
  effects: [] as {deps: unknown[]; cleanup?: () => void}[], pending: [] as (() => void)[],
}));
const client = vi.hoisted(() => ({
  status: vi.fn<(comicId?: string) => Promise<TrackingView>>(),
  listener: undefined as (() => void) | undefined,
  unsubscribe: vi.fn(),
}));
vi.mock('react', () => ({
  useState: <T>(initial?: T) => {
    const index = hooks.state++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: T) => {
      if (!Object.is(next, hooks.states[index])) hooks.dirty = true;
      hooks.states[index] = next;
    }];
  },
  useRef: (initial: unknown) => hooks.refs[hooks.ref++] ??= {current: initial},
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = hooks.memo++, previous = hooks.memos[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.memos[index] = {value: callback, deps};
    return hooks.memos[index].value;
  },
  useEffect: (callback: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.effect++, previous = hooks.effects[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = {deps, cleanup: callback() || undefined};
    });
  },
}));
vi.mock('../../tracking/client', () => ({trackingClient: {
  status: client.status,
  subscribe: (listener: () => void) => {
    client.listener = listener;
    return () => {client.listener = undefined; client.unsubscribe();};
  },
}}));
vi.mock('../../i18n/runtime', () => ({msg: (value: string) => value}));
import {useTracking} from './useTracking';

const view: TrackingView = {configured: true, enabled: false};
const cancelled = '已取消 AniList 授权。';
const unavailable = 'AniList 暂时不可用或请求受限，请稍后重试。';
const flush = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => {resolve = done; reject = failed;});
  return {promise, resolve, reject};
}
function render(comicId?: string) {
  let controller!: ReturnType<typeof useTracking>;
  do {
    hooks.state = hooks.ref = hooks.memo = hooks.effect = 0;
    hooks.dirty = false;
    controller = useTracking(comicId);
    while (hooks.pending.length) hooks.pending.shift()!();
  } while (hooks.dirty);
  return controller;
}
function cleanup() {
  for (const effect of hooks.effects) effect.cleanup?.();
  hooks.effects = []; hooks.pending = [];
}
beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.memos = []; hooks.effects = []; hooks.pending = [];
  client.status.mockReset().mockResolvedValue(view);
  client.unsubscribe.mockClear();
  vi.stubGlobal('window', new EventTarget());
});
afterEach(async () => {cleanup(); await flush(); vi.unstubAllGlobals();});

describe('tracking observer error lifetime', () => {
  it.each(['subscription', 'focus'] as const)('keeps a failed command visible after a late %s status success', async trigger => {
    render(); await flush();
    const pending = deferred<TrackingView>();
    client.status.mockReturnValueOnce(pending.promise);
    expect(await render().run(async () => {
      if (trigger === 'subscription') client.listener?.();
      else window.dispatchEvent(new Event('focus'));
      throw Error('cancelled');
    })).toBe(false);
    expect(render()).toMatchObject({error: cancelled, busy: false});
    pending.resolve({...view, configured: false}); await flush();
    expect(render()).toMatchObject({error: cancelled, view: {configured: false}});
    window.dispatchEvent(new Event('focus')); await flush();
    expect(render().error).toBe(cancelled);
  });

  it('does not replace an operation error with a passive status error', async () => {
    render(); await flush();
    await render().run(async () => {throw Error('cancelled');});
    client.status.mockRejectedValueOnce(Error('unavailable'));
    client.listener?.(); await flush();
    expect(render().error).toBe(cancelled);
  });

  it('clears the previous operation error when a new operation starts', async () => {
    render(); await flush();
    await render().run(async () => {throw Error('cancelled');});
    const action = deferred<void>(), running = render().run(() => action.promise);
    expect(render()).toMatchObject({error: '', busy: true});
    action.resolve(); expect(await running).toBe(true);
    expect(render()).toMatchObject({error: '', busy: false});
  });

  it('lets explicit refresh clear the command error and report its own failure', async () => {
    render(); await flush();
    await render().run(async () => {throw Error('cancelled');});
    client.status.mockRejectedValueOnce(Error('unavailable'));
    await render().refresh();
    expect(render().error).toBe(unavailable);
    await render().refresh();
    expect(render().error).toBe('');
  });

  it('ignores a late status failure from before a new operation', async () => {
    render(); await flush();
    const pending = deferred<TrackingView>(), action = deferred<void>();
    client.status.mockReturnValueOnce(pending.promise);
    client.listener?.();
    const running = render().run(() => action.promise);
    pending.reject(Error('unavailable')); await flush();
    expect(render()).toMatchObject({error: '', busy: true});
    action.resolve(); await running;
    expect(render().error).toBe('');
  });

  it('ignores delayed command and status responses after unmount', async () => {
    const pending = deferred<TrackingView>(), action = deferred<void>();
    client.status.mockReturnValueOnce(pending.promise);
    const running = render().run(() => action.promise);
    cleanup();
    const snapshot = [...hooks.states], calls = client.status.mock.calls.length;
    pending.reject(Error('unavailable')); action.reject(Error('cancelled'));
    expect(await running).toBe(false); await flush();
    window.dispatchEvent(new Event('focus')); await flush();
    expect(hooks.states).toEqual(snapshot);
    expect(client.listener).toBeUndefined();
    expect(client.status).toHaveBeenCalledTimes(calls);
    expect(client.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not report stale success or unlock a replacement command during its status refresh', async () => {
    render(); await flush();
    const pending = deferred<TrackingView>(), nextAction = deferred<void>();
    client.status.mockReturnValueOnce(pending.promise);
    const oldRun = render().run(async () => {}); await flush();
    const nextRun = render().run(() => nextAction.promise, true);
    pending.resolve(view); expect(await oldRun).toBe(false);
    expect(render()).toMatchObject({error: '', busy: true});
    nextAction.resolve(); expect(await nextRun).toBe(true);
    expect(render()).toMatchObject({error: '', busy: false});
  });

  it('releases the old scope lock and ignores its failure when another comic is opened', async () => {
    render('first'); await flush();
    const oldAction = deferred<void>(), nextAction = deferred<void>();
    const oldRun = render('first').run(() => oldAction.promise);
    render('second'); await flush();
    expect(render('second')).toMatchObject({error: '', busy: false});
    const nextRun = render('second').run(() => nextAction.promise);
    oldAction.reject(Error('cancelled')); expect(await oldRun).toBe(false);
    expect(render('second')).toMatchObject({error: '', busy: true});
    nextAction.resolve(); expect(await nextRun).toBe(true);
    expect(render('second')).toMatchObject({error: '', busy: false});
  });
});
