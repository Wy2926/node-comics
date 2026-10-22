import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ReadingEntry} from '../src/types';

// The real stream hook and timers, with only React scheduling and DOM geometry
// simulated. No source, image or translation service participates in these tests.
const hooks = vi.hoisted(() => ({
  state: 0, ref: 0, memo: 0, effect: 0, dirty: false,
  states: [] as unknown[], refs: [] as {current: unknown}[],
  memos: [] as {deps: unknown[]; value: unknown}[],
  effects: [] as {deps?: unknown[]; cleanup?: () => void}[],
  layout: [] as (() => void)[], passive: [] as (() => void)[],
}));
vi.mock('react', async original => {
  const schedule = (queue: (() => void)[], callback: () => void | (() => void), deps?: unknown[]) => {
    const index = hooks.effect++, previous = hooks.effects[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) queue.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = {deps, cleanup: callback() || undefined};
    });
  };
  return {
    ...await original<typeof import('react')>(),
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.state++;
      if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [hooks.states[index], (next: T | ((value: T) => T)) => {
        const value = typeof next === 'function' ? (next as (value: T) => T)(hooks.states[index] as T) : next;
        if (!Object.is(value, hooks.states[index])) hooks.dirty = true;
        hooks.states[index] = value;
      }];
    },
    useRef: (current: unknown) => hooks.refs[hooks.ref++] ??= {current},
    useMemo: (compute: () => unknown, deps: unknown[]) => {
      const index = hooks.memo++, previous = hooks.memos[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.memos[index] = {deps, value: compute()};
      return hooks.memos[index].value;
    },
    useEffect: (callback: () => void | (() => void), deps?: unknown[]) => schedule(hooks.passive, callback, deps),
    useLayoutEffect: (callback: () => void | (() => void), deps?: unknown[]) => schedule(hooks.layout, callback, deps),
  };
});
import {useChapterStream} from '../src/reader/useChapterStream';

const pageHeight = 16000;
let entry: ReadingEntry, sequence: ReadingEntry[], mounted: boolean, attached: boolean;
let stream: ReturnType<typeof useChapterStream>;
let viewport: HTMLDivElement, stack: HTMLDivElement;
let pageDocument: EventTarget & {hidden: boolean; visibilityState: string}, pageWindow: EventTarget;
const update = vi.fn((next: ReadingEntry) => {entry = next; sequence = [entry]; hooks.dirty = true;});
let onUpdate: (next: ReadingEntry) => void;
const onLoadEntry = vi.fn(), onActiveEntry = vi.fn(), onMarkRead = vi.fn(async () => {}), notify = vi.fn();

function render() {
  let remaining = 20;
  do {
    if (!remaining--) throw Error('Stream did not settle');
    hooks.state = hooks.ref = hooks.memo = hooks.effect = 0; hooks.dirty = false;
    stream = useChapterStream({copy: entry, sequence, layout: 'continuous', update: onUpdate, onActiveEntry, onLoadEntry, onMarkRead, notify});
    stream.viewport.current = attached ? viewport : null;
    if (attached) stream.stacks.current.set(entry.id, stack);
    stream.geometry.current = new Map([[entry.id, {copy: entry, offsets: [0, pageHeight, pageHeight * 2], start: 0, end: 2, before: 0, after: 0}]]);
    while (hooks.layout.length) hooks.layout.shift()!();
    while (hooks.passive.length) hooks.passive.shift()!();
  } while (hooks.dirty);
}
function mount(relativeOffset = .25, attach = true) {
  entry = {id: 'long-chapter', comicId: 'comic', contentId: 'content', title: 'Long chapter', source: 'website', sourceKey: 'long-chapter', generation: 1,
    createdAt: 0, updatedAt: 0, lastReadAt: 1, discoveryComplete: true, pageId: 'page-0', relativeOffset,
    pages: [0, 1].map(index => ({id: `page-${index}`, name: String(index + 1), width: 690, height: pageHeight, jobs: [], outputBlobs: {}}))};
  sequence = [entry]; mounted = true; attached = attach;
  render();
}
function unmount() {
  if (!mounted) return;
  mounted = false;
  // Passive cleanup may run after the viewport ref has been detached. The last
  // observed reading anchor must survive without measuring a now-missing node.
  stream.viewport.current = null; stream.stacks.current.clear();
  for (const effect of hooks.effects) effect.cleanup?.();
}
function visibility(hidden: boolean) {
  pageDocument.hidden = hidden; pageDocument.visibilityState = hidden ? 'hidden' : 'visible';
  pageDocument.dispatchEvent(new Event('visibilitychange'));
  if (mounted) render();
}
function leave(kind: 'hidden' | 'pagehide' | 'unmount') {
  if (kind === 'hidden') visibility(true);
  else if (kind === 'pagehide') pageWindow.dispatchEvent(new Event('pagehide'));
  else unmount();
}
function readTo(relativeOffset: number) {
  // Let the initial programmatic restoration finish before a real scroll.
  vi.advanceTimersByTime(16);
  viewport.scrollTop = pageHeight * relativeOffset; stream.scroll(); render();
}

beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.memos = []; hooks.effects = []; hooks.layout = []; hooks.passive = [];
  mounted = false; onUpdate = update;
  for (const callback of [update, onLoadEntry, onActiveEntry, onMarkRead, notify]) callback.mockClear();
  vi.useFakeTimers(); vi.setSystemTime(10000);
  pageDocument = Object.assign(new EventTarget(), {hidden: false, visibilityState: 'visible'}); pageWindow = new EventTarget();
  vi.stubGlobal('document', pageDocument); vi.stubGlobal('window', pageWindow);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  viewport = {scrollTop: 0, clientTop: 0, clientHeight: 800, scrollHeight: pageHeight * 2, getBoundingClientRect: () => ({top: 0})} as unknown as HTMLDivElement;
  stack = {getBoundingClientRect: () => ({top: -viewport.scrollTop})} as unknown as HTMLDivElement;
});
afterEach(() => {unmount(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('continuous reader lifecycle position saving', () => {
  it('keeps normal scroll writes debounced until 350ms', () => {
    mount(); readTo(.625);
    vi.advanceTimersByTime(349); expect(update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0]).toMatchObject({pageId: 'page-0', relativeOffset: .625});
  });

  it.each(['hidden', 'pagehide', 'unmount'] as const)('flushes the last long-page scroll immediately on %s, before the debounce expires', kind => {
    mount(); readTo(.625); expect(update).not.toHaveBeenCalled();
    leave(kind);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0]).toMatchObject({id: 'long-chapter', pageId: 'page-0', relativeOffset: .625});
    if (mounted) visibility(true);
    leave('pagehide'); unmount();
    vi.advanceTimersByTime(1000); expect(update).toHaveBeenCalledOnce();
  });

  it('does not save again when an explicit reader exit already persisted the anchor', () => {
    mount(); readTo(.625); stream.preserve(); stream.persist();
    expect(update).toHaveBeenCalledOnce();
    visibility(true); leave('pagehide'); unmount(); vi.advanceTimersByTime(1000);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0]).toMatchObject({pageId: 'page-0', relativeOffset: .625});
  });

  it('does not repeat an already completed debounce save during lifecycle teardown', () => {
    mount(); readTo(.625); vi.advanceTimersByTime(350); render();
    expect(update).toHaveBeenCalledOnce();
    visibility(true); leave('pagehide'); unmount(); vi.advanceTimersByTime(1000);
    expect(update).toHaveBeenCalledOnce();
  });

  it.each(['hidden', 'debounce'] as const)('uses the latest update callback when %s saves a scroll scheduled before a parent rerender', kind => {
    mount(); readTo(.625);
    const latestUpdate = vi.fn((next: ReadingEntry) => {entry = next; sequence = [entry]; hooks.dirty = true;});
    onUpdate = latestUpdate; render();
    if (kind === 'hidden') visibility(true);
    else vi.advanceTimersByTime(350);
    expect(update).not.toHaveBeenCalled();
    expect(latestUpdate).toHaveBeenCalledOnce();
    expect(latestUpdate.mock.calls[0][0]).toMatchObject({pageId: 'page-0', relativeOffset: .625});
  });

  it.each(['hidden', 'pagehide', 'unmount'] as const)('does not replace the saved nonzero anchor during initial programmatic restoration and %s', kind => {
    mount(.375);
    expect(viewport.scrollTop).toBe(pageHeight * .375);
    stream.scroll(); // Programmatic restore scroll while suppression is active.
    leave(kind); vi.advanceTimersByTime(1000);
    expect(update).not.toHaveBeenCalled();
    expect(stream.anchor.current).toMatchObject({pageId: 'page-0', relativeOffset: .375});
  });

  it('does not persist a zero placeholder when lifecycle events precede viewport attachment', () => {
    mount(.375, false);
    visibility(true); leave('pagehide'); unmount(); vi.advanceTimersByTime(1000);
    expect(update).not.toHaveBeenCalled();
    expect(entry.relativeOffset).toBe(.375);
  });
});
