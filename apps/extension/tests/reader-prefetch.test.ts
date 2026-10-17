import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ReaderImagePrefetch, type ReaderPrefetchOptions, type PrefetchLease} from '../src/reader/image-prefetch';

const hooks = vi.hoisted(() => ({
  cursor: 0, effectCursor: 0, refs: [] as {current: unknown}[],
  effects: [] as {deps?: readonly unknown[]; cleanup?: () => void}[], pending: [] as (() => void)[], layout: [] as (() => void)[],
  acquire: vi.fn(),
}));
vi.mock('../src/comics/application/image-access', () => ({acquireImage: hooks.acquire}));
vi.mock('react', () => {
  const effect = (callback: () => void | (() => void), deps: readonly unknown[] | undefined, layout: boolean) => {
    const index = hooks.effectCursor++, previous = hooks.effects[index];
    if (deps && previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
    (layout ? hooks.layout : hooks.pending).push(() => {previous?.cleanup?.(); hooks.effects[index] = {deps, cleanup: callback() || undefined};});
  };
  return {
    useRef: (current: unknown) => hooks.refs[hooks.cursor++] ?? (hooks.refs[hooks.cursor - 1] = {current}),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(callback, deps, false),
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(callback, deps, true),
  };
});
import {useReaderPrefetch} from '../src/reader/useReaderPrefetch';

const MiB = 1024 * 1024;
const managers: ReaderImagePrefetch[] = [];
const options = (): ReaderPrefetchOptions => ({scope: 'entry/content/1/original', current: ['one'], next: ['two', 'three'], ready: true, enabled: true});
function lease(size = 10) {
  // Only size participates in retention accounting; do not allocate 64 MiB test buffers.
  return {blob: {size} as Blob, release: vi.fn()};
}
function source() {
  const calls: {key: string; signal: AbortSignal; resolve: (value: PrefetchLease) => void; reject: (error: unknown) => void}[] = [];
  const acquire = vi.fn((key: string, signal: AbortSignal, _priority: 'current' | 'prefetch') => new Promise<PrefetchLease>((resolve, reject) => {
    calls.push({key, signal, resolve, reject});
  }));
  return {calls, acquire};
}
function fixture() {
  const f = source(), manager = new ReaderImagePrefetch(f.acquire);
  managers.push(manager);
  let value = options();
  const update = (changes: Partial<ReaderPrefetchOptions> = {}) => {value = {...value, ...changes}; manager.update(value);};
  return {...f, manager, update};
}
const advance = (milliseconds = 0) => vi.advanceTimersByTimeAsync(milliseconds);
class Visibility extends EventTarget {hidden = false;}
let visibility: Visibility;
function render(changes: Partial<ReaderPrefetchOptions> = {}, previous = options(), childPassive?: () => void) {
  const value = {...previous, ...changes};
  hooks.cursor = hooks.effectCursor = 0;
  hooks.pending = []; hooks.layout = [];
  expect(useReaderPrefetch(value)).toBeUndefined();
  for (const effect of hooks.layout) effect();
  childPassive?.();
  for (const effect of hooks.pending) effect();
  return value;
}
function unmount() {
  for (const effect of hooks.effects) effect.cleanup?.();
  hooks.effects = [];
}
beforeEach(() => {
  vi.useFakeTimers();
  hooks.refs = []; hooks.effects = []; hooks.pending = []; hooks.layout = []; hooks.acquire.mockReset();
  visibility = new Visibility();
  vi.stubGlobal('document', visibility);
});
afterEach(() => {
  unmount();
  for (const manager of managers.splice(0)) manager.dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('reader byte-only prefetch window', () => {
  it('requires 150 ms of current readiness and does not debounce unchanged renders forever', async () => {
    const f = fixture();
    f.update({ready: false}); await advance(1000);
    expect(f.acquire).not.toHaveBeenCalled();
    f.update({ready: true}); await advance(100);
    f.update({current: ['one'], next: ['two', 'three']}); await advance(49);
    expect(f.acquire).not.toHaveBeenCalled();
    await advance(1);
    expect(f.acquire).toHaveBeenCalledExactlyOnceWith('two', expect.any(AbortSignal), 'prefetch');
  });

  it('restarts the readiness delay after loading or the visible group changes', async () => {
    const f = fixture(); f.update(); await advance(100);
    f.update({ready: false}); await advance(1000);
    f.update({ready: true}); await advance(100);
    f.update({current: ['different']}); await advance(149);
    expect(f.acquire).not.toHaveBeenCalled();
    await advance(1); expect(f.acquire).toHaveBeenCalledOnce();
  });

  it('deduplicates, excludes visible and translated keys, and only reads the next two originals', async () => {
    const f = fixture();
    f.update({next: ['', 'one', 'result:translated', 'two', 'two', 'three', 'four']});
    await advance(150); f.calls[0].resolve(lease()); await advance();
    f.calls[1].resolve(lease()); await advance(1000);
    expect(f.calls.map(call => call.key)).toEqual(['two', 'three']);
  });

  it('keeps at most one speculative request in flight', async () => {
    const f = fixture(); f.update(); await advance(10000);
    expect(f.calls).toHaveLength(1);
    f.calls[0].resolve(lease()); await advance();
    expect(f.calls).toHaveLength(2);
    f.calls[1].resolve(lease()); await advance(10000);
    expect(f.calls).toHaveLength(2);
  });

  it('pauses new work when unready while allowing an in-window request to finish', async () => {
    const f = fixture(); f.update(); await advance(150);
    f.update({ready: false}); expect(f.calls[0].signal.aborted).toBe(false);
    const first = lease(); f.calls[0].resolve(first); await advance(1000);
    expect(first.release).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(1);
    f.update({ready: true}); await advance(149); expect(f.calls).toHaveLength(1);
    await advance(1); expect(f.calls.map(call => call.key)).toEqual(['two', 'three']);
  });

  it('hands off both retained and still-loading pages until the new current group is ready', async () => {
    const f = fixture(); f.update(); await advance(150);
    const first = lease(), second = lease();
    f.calls[0].resolve(first); await advance();
    f.update({current: ['two', 'three'], next: ['four', 'five'], ready: false});
    expect(first.release).not.toHaveBeenCalled(); expect(f.calls[1].signal.aborted).toBe(false);
    f.calls[1].resolve(second); await advance(1000);
    expect(second.release).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(2);
    f.update({ready: true});
    expect(first.release).toHaveBeenCalledOnce(); expect(second.release).toHaveBeenCalledOnce();
    await advance(149); expect(f.calls).toHaveLength(2);
    await advance(1); expect(f.calls[2].key).toBe('four');
  });

  it('uses the same bounded handoff for an eleven-page continuous display window', async () => {
    const f = fixture();
    const current = Object.freeze(Array.from({length: 11}, (_, index) => `page-${index + 1}`));
    f.update({current, next: Object.freeze(['page-11', 'page-12', 'page-13', 'page-14'])}); await advance(150);
    const first = lease(), second = lease();
    f.calls[0].resolve(first); await advance(); f.calls[1].resolve(second); await advance();
    expect(f.calls.map(call => call.key)).toEqual(['page-12', 'page-13']);
    f.update({current: Array.from({length: 11}, (_, index) => `page-${index + 3}`), next: ['page-14', 'page-15'], ready: false});
    expect(first.release).not.toHaveBeenCalled(); expect(second.release).not.toHaveBeenCalled();
    await advance(1000); expect(f.calls).toHaveLength(2);
    f.update({ready: true});
    expect(first.release).toHaveBeenCalledOnce(); expect(second.release).toHaveBeenCalledOnce();
    await advance(150); expect(f.calls[2].key).toBe('page-14'); expect(current).toHaveLength(11);
  });

  it('lets foreground acquisition share bytes and still validate its own access with disk cache disabled', async () => {
    let retained: {blob: Blob; users: number} | undefined;
    const readSource = vi.fn(() => new Blob(['original'])), validate = vi.fn();
    const acquire = async (_key: string, _signal: AbortSignal, _priority: 'current' | 'prefetch'): Promise<PrefetchLease> => {
      validate();
      const value = retained ??= {blob: readSource(), users: 0}; value.users++;
      let released = false;
      return {blob: value.blob, release() {if (!released && --value.users === 0) retained = undefined; released = true;}};
    };
    const manager = new ReaderImagePrefetch(acquire); managers.push(manager);
    manager.update({...options(), next: ['two']}); await advance(150);
    manager.update({...options(), current: ['two'], next: [], ready: false});
    const visible = await acquire('two', new AbortController().signal, 'current');
    expect(readSource).toHaveBeenCalledOnce(); expect(validate).toHaveBeenCalledTimes(2);
    manager.update({...options(), current: ['two'], next: [], ready: true});
    expect(retained?.users).toBe(1);
    visible.release(); expect(retained).toBeUndefined();
  });

  it.each(['held', 'inflight'] as const)('shares %s next-chapter bytes with foreground without rereading the source', async state => {
    let complete!: (blob: Blob) => void;
    let retained: {bytes: Promise<Blob>; users: number} | undefined;
    const readSource = vi.fn(() => new Promise<Blob>(resolve => {complete = resolve;})), validate = vi.fn();
    const acquire = async (_key: string, _signal: AbortSignal, _priority: 'current' | 'prefetch'): Promise<PrefetchLease> => {
      validate();
      const value = retained ??= {bytes: readSource(), users: 0}; value.users++;
      const blob = await value.bytes;
      let released = false;
      return {blob, release() {if (!released && --value.users === 0) retained = undefined; released = true;}};
    };
    const manager = new ReaderImagePrefetch(acquire); managers.push(manager);
    const identities = new Map([
      ['chapter-a:last', 'chapter-a/content-a/1/last'],
      ['chapter-b:first', 'chapter-b/content-b/1/first'],
    ]);
    const value = {...options(), scope: 'reader/book/original', identities};
    manager.update({...value, current: ['chapter-a:last'], next: ['chapter-b:first']}); await advance(150);
    if (state === 'held') {complete(new Blob(['next chapter'])); await advance();}
    manager.update({...value, current: ['chapter-b:first'], next: [], ready: false});
    const foreground = acquire('chapter-b:first', new AbortController().signal, 'current');
    if (state === 'inflight') complete(new Blob(['next chapter']));
    const visible = await foreground; await advance();
    expect(readSource).toHaveBeenCalledOnce(); expect(validate).toHaveBeenCalledTimes(2);
    expect(retained?.users).toBe(2);
    manager.update({...value, current: ['chapter-b:first'], next: [], ready: true});
    expect(retained?.users).toBe(1);
    visible.release(); expect(retained).toBeUndefined();
  });

  it('invalidates only the changed page identity and frees its byte budget for the replacement', async () => {
    const f = fixture();
    f.update({identities: new Map([['two', 'chapter-a/1/two'], ['three', 'chapter-b/1/three']])}); await advance(150);
    const old = lease(32 * MiB), unchanged = lease(32 * MiB);
    f.calls[0].resolve(old); await advance(); f.calls[1].resolve(unchanged); await advance();
    f.update({identities: new Map([['two', 'chapter-a/2/two'], ['three', 'chapter-b/1/three']])});
    expect(old.release).toHaveBeenCalledOnce(); expect(unchanged.release).not.toHaveBeenCalled();
    await advance(149); expect(f.calls).toHaveLength(2);
    await advance(1); expect(f.calls[2].key).toBe('two');
    const replacement = lease(32 * MiB); f.calls[2].resolve(replacement); await advance();
    expect(replacement.release).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(3);
    f.manager.dispose();
    expect(old.release).toHaveBeenCalledOnce(); expect(unchanged.release).toHaveBeenCalledOnce();
    expect(replacement.release).toHaveBeenCalledOnce();
  });

  it('cancels same-key stale work and releases its late lease without disturbing the new generation', async () => {
    const f = fixture();
    f.update({identities: new Map([['two', 'chapter/1/two'], ['three', 'chapter/1/three']])}); await advance(150);
    f.update({identities: new Map([['two', 'chapter/2/two'], ['three', 'chapter/1/three']])});
    expect(f.calls[0].signal.aborted).toBe(true);
    await advance(150); expect(f.calls[1].key).toBe('two');
    const stale = lease(64 * MiB); f.calls[0].resolve(stale); await advance();
    expect(stale.release).toHaveBeenCalledOnce(); expect(f.calls[1].signal.aborted).toBe(false);
    expect(f.calls).toHaveLength(2);
    const fresh = lease(32 * MiB); f.calls[1].resolve(fresh); await advance();
    expect(fresh.release).not.toHaveBeenCalled(); expect(f.calls[2].key).toBe('three');
    const second = lease(32 * MiB); f.calls[2].resolve(second); await advance();
    expect(second.release).not.toHaveBeenCalled();
    f.manager.dispose(); expect(stale.release).toHaveBeenCalledOnce();
  });

  it('retries a failed key after an identity change, including when the caller mutates the same map', async () => {
    const f = fixture(), identities = new Map([['two', 'chapter/1/two']]);
    f.update({identities, next: ['two']}); await advance(150);
    f.calls[0].reject(new Error('old generation unavailable')); await advance();
    f.update({identities: new Map(identities)}); await advance(1000); expect(f.calls).toHaveLength(1);
    f.update({identities}); identities.set('two', 'chapter/2/two'); f.update({identities});
    await advance(149); expect(f.calls).toHaveLength(1);
    await advance(1); expect(f.calls[1].key).toBe('two');
    f.calls[1].reject(new Error('new generation unavailable')); await advance();
    f.update(); await advance(1000); expect(f.calls).toHaveLength(2);
  });

  it.each(['scope', 'disabled', 'outside', 'unmount'] as const)('releases held bytes and aborts the old request immediately on %s', async reason => {
    const f = fixture(); f.update(); await advance(150);
    const first = lease(); f.calls[0].resolve(first); await advance();
    if (reason === 'scope') f.update({scope: 'other-entry/content/2/translated'});
    if (reason === 'disabled') f.update({enabled: false});
    if (reason === 'outside') f.update({current: ['four'], next: ['five', 'six'], ready: false});
    if (reason === 'unmount') f.manager.dispose();
    expect(first.release).toHaveBeenCalledOnce(); expect(f.calls[1].signal.aborted).toBe(true);
    const late = lease(); f.calls[1].resolve(late); await advance();
    expect(late.release).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(2);
    f.manager.dispose(); expect(first.release).toHaveBeenCalledOnce(); expect(late.release).toHaveBeenCalledOnce();
  });

  it('does not let a cancelled late result disturb the new scope or retain its bytes', async () => {
    const f = fixture(); f.update(); await advance(150);
    f.update({scope: 'other-entry', current: ['new-one'], next: ['new-two', 'new-three']}); await advance(150);
    const stale = lease(64 * MiB); f.calls[0].resolve(stale); await advance();
    expect(stale.release).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(2);
    const fresh = lease(); f.calls[1].resolve(fresh); await advance();
    expect(fresh.release).not.toHaveBeenCalled(); expect(f.calls[2].key).toBe('new-three');
  });

  it('aborts a handoff request once foreground pixels are ready and releases any late lease', async () => {
    const f = fixture(); f.update(); await advance(150);
    f.update({current: ['two'], next: ['three'], ready: false});
    expect(f.calls[0].signal.aborted).toBe(false);
    f.update({ready: true}); expect(f.calls[0].signal.aborted).toBe(true);
    const late = lease(); f.calls[0].resolve(late); await advance();
    expect(late.release).toHaveBeenCalledOnce();
    await advance(150); expect(f.calls[1].key).toBe('three');
  });

  it('retains exactly 64 MiB but releases an additional byte without retrying it', async () => {
    const f = fixture(); f.update(); await advance(150);
    const full = lease(64 * MiB), overflow = lease(1);
    f.calls[0].resolve(full); await advance(); f.calls[1].resolve(overflow); await advance();
    expect(full.release).not.toHaveBeenCalled(); expect(overflow.release).toHaveBeenCalledOnce();
    for (let index = 0; index < 3; index++) {f.update(); await advance(1000);}
    expect(f.calls).toHaveLength(2);
    f.manager.dispose(); expect(full.release).toHaveBeenCalledOnce(); expect(overflow.release).toHaveBeenCalledOnce();
  });

  it('stops unrequested items after an oversized first page and frees its budget for another window', async () => {
    const f = fixture(); f.update(); await advance(150);
    const oversized = lease(64 * MiB + 1); f.calls[0].resolve(oversized); await advance();
    expect(oversized.release).toHaveBeenCalledOnce();
    f.update({ready: false}); f.update({ready: true}); await advance(1000);
    expect(f.calls).toHaveLength(1);
    f.update({current: ['two'], next: ['four']}); await advance(150);
    const full = lease(64 * MiB); f.calls[1].resolve(full); await advance();
    expect(full.release).not.toHaveBeenCalled();
  });

  it('accounts for the sum of retained blobs and subtracts bytes when a page leaves', async () => {
    const f = fixture(); f.update(); await advance(150);
    const first = lease(40 * MiB), second = lease(30 * MiB);
    f.calls[0].resolve(first); await advance(); f.calls[1].resolve(second); await advance();
    expect(first.release).not.toHaveBeenCalled(); expect(second.release).toHaveBeenCalledOnce();
    f.update({current: ['four'], next: ['five']}); await advance(150);
    const next = lease(64 * MiB); f.calls[2].resolve(next); await advance();
    expect(first.release).toHaveBeenCalledOnce(); expect(next.release).not.toHaveBeenCalled();
  });

  it('silently attempts each failure only once per next window, without blocking the other page', async () => {
    const f = fixture(); f.update(); await advance(150);
    f.calls[0].reject(new Error('source unavailable')); await advance();
    expect(f.calls[1].key).toBe('three');
    f.calls[1].reject(new Error('also unavailable')); await advance();
    f.update(); f.update({ready: false}); f.update({ready: true}); await advance(10000);
    expect(f.calls).toHaveLength(2);
    f.update({next: ['two']}); await advance(150);
    expect(f.calls[2].key).toBe('two');
  });

  it('does not own or suppress a foreground retry after speculative failure', async () => {
    const f = fixture(); f.update({next: ['two']}); await advance(150);
    f.calls[0].reject(new Error('temporary')); await advance();
    const foreground = f.acquire('two', new AbortController().signal, 'current');
    const visible = lease(); f.calls[1].resolve(visible);
    await expect(foreground).resolves.toBe(visible);
    expect(f.acquire).toHaveBeenLastCalledWith('two', expect.any(AbortSignal), 'current');
    f.update(); await advance(1000);
    expect(f.calls).toHaveLength(2); expect(visible.release).not.toHaveBeenCalled(); visible.release();
  });

  it('treats a synchronous acquisition error as a single silent failed attempt', async () => {
    const acquire = vi.fn(() => {throw new Error('unavailable');});
    const manager = new ReaderImagePrefetch(acquire); managers.push(manager);
    manager.update(options()); await advance(150); manager.update(options()); await advance(1000);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('does not request at a chapter boundary or when disabled, and removes pending delay on cleanup', async () => {
    const f = fixture(); f.update({next: []}); await advance(1000);
    f.update({next: ['two'], enabled: false}); await advance(1000);
    expect(f.acquire).not.toHaveBeenCalled();
    f.update({enabled: true}); expect(vi.getTimerCount()).toBe(1);
    f.manager.dispose(); await advance(1000);
    expect(f.acquire).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('never constructs images, object URLs, DOM nodes, or bitmaps for retained bytes', async () => {
    const image = vi.fn(), bitmap = vi.fn(), element = vi.fn();
    vi.stubGlobal('Image', image); vi.stubGlobal('createImageBitmap', bitmap);
    Object.assign(visibility, {createElement: element});
    const createURL = vi.spyOn(URL, 'createObjectURL');
    const acquire = vi.fn(async () => ({blob: new Blob(['encoded bytes']), release: vi.fn()}));
    const manager = new ReaderImagePrefetch(acquire); managers.push(manager);
    manager.update(options()); await advance(150);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(image).not.toHaveBeenCalled(); expect(bitmap).not.toHaveBeenCalled();
    expect(element).not.toHaveBeenCalled(); expect(createURL).not.toHaveBeenCalled();
  });
});

describe('reader prefetch lifecycle hook', () => {
  it('invalidates changed page identities in layout before same-scope child foreground acquisition', async () => {
    const f = source(); hooks.acquire.mockImplementation(f.acquire);
    const value = render({identities: new Map([['two', 'chapter/1/two'], ['three', 'chapter/1/three']])}); await advance(150);
    const first = lease(); f.calls[0].resolve(first); await advance();
    const childAcquire = vi.fn(() => {
      expect(first.release).toHaveBeenCalledOnce(); expect(f.calls[1].signal.aborted).toBe(true);
    });
    render({
      identities: new Map([['two', 'chapter/2/two'], ['three', 'chapter/2/three']]),
      current: ['two'], next: ['three'], ready: false,
    }, value, childAcquire);
    expect(childAcquire).toHaveBeenCalledOnce();
    const late = lease(); f.calls[1].resolve(late); await advance();
    expect(late.release).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(2);
  });

  it('releases the old source generation in layout before a new child passive acquisition joins it', async () => {
    const f = source(); hooks.acquire.mockImplementation(f.acquire);
    const value = render(); await advance(150);
    const first = lease(); f.calls[0].resolve(first); await advance();
    const childAcquire = vi.fn(() => {
      // A page reference is unchanged by authorization generation. No old work may still be pinned.
      expect(first.release).toHaveBeenCalledOnce();
      expect(f.calls[1].signal.aborted).toBe(true);
    });
    render({scope: 'entry/content/2/original', current: ['two'], next: ['three'], ready: false}, value, childAcquire);
    expect(childAcquire).toHaveBeenCalledOnce();
    const late = lease(); f.calls[1].resolve(late); await advance();
    expect(late.release).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(2);
  });

  it('keeps a same-scope handoff pinned through the child passive acquisition and releases only after ready', async () => {
    const f = source(); hooks.acquire.mockImplementation(f.acquire);
    const value = render({next: ['two']}); await advance(150);
    const held = lease(); f.calls[0].resolve(held); await advance();
    const next = render({current: ['two'], next: ['three'], ready: false}, value, () => {
      expect(held.release).not.toHaveBeenCalled(); expect(f.calls[0].signal.aborted).toBe(false);
    });
    render({ready: true}, next);
    expect(held.release).toHaveBeenCalledOnce();
  });

  it('releases and aborts on hide, then prepares the latest window after returning', async () => {
    const f = source(); hooks.acquire.mockImplementation(f.acquire);
    let value = render(); await advance(150);
    const first = lease(); f.calls[0].resolve(first); await advance();
    visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
    expect(first.release).toHaveBeenCalledOnce(); expect(f.calls[1].signal.aborted).toBe(true);
    const late = lease(); f.calls[1].resolve(late); await advance(); expect(late.release).toHaveBeenCalledOnce();
    value = render({current: ['four'], next: ['five']}, value); await advance(1000);
    expect(f.calls).toHaveLength(2);
    visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
    await advance(149); expect(f.calls).toHaveLength(2);
    await advance(1); expect(f.calls[2].key).toBe('five');
  });

  it('starts neither a timer nor acquisition while initially hidden or disabled', async () => {
    const f = source(); hooks.acquire.mockImplementation(f.acquire);
    visibility.hidden = true; let value = render(); await advance(1000);
    expect(vi.getTimerCount()).toBe(0); expect(f.calls).toHaveLength(0);
    value = render({enabled: false}, value); visibility.hidden = false;
    visibility.dispatchEvent(new Event('visibilitychange')); await advance(1000);
    expect(f.calls).toHaveLength(0);
    render({enabled: true}, value); await advance(150); expect(f.calls).toHaveLength(1);
  });

  it('keeps unchanged rerenders stable and removes its listener, timer, and leases on unmount', async () => {
    const f = source(); hooks.acquire.mockImplementation(f.acquire);
    const remove = vi.spyOn(visibility, 'removeEventListener');
    let value = render(); await advance(100); value = render({}, value); await advance(50);
    const first = lease(); f.calls[0].resolve(first); await advance();
    unmount();
    expect(first.release).toHaveBeenCalledOnce(); expect(f.calls[1].signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledExactlyOnceWith('visibilitychange', expect.any(Function));
    visibility.dispatchEvent(new Event('visibilitychange')); await advance(1000);
    expect(f.calls).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('can resume after strict-effect cleanup without reusing a cancelled request', async () => {
    const f = source(); hooks.acquire.mockImplementation(f.acquire);
    const value = render(); await advance(150); unmount();
    render({}, value); await advance(150);
    expect(f.calls).toHaveLength(2); expect(f.calls[0].signal.aborted).toBe(true);
    expect(f.calls[1].signal.aborted).toBe(false);
  });
});
