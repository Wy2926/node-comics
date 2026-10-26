import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ReadingEntry, Settings} from '../src/types';

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
let layout: Settings['layout'];
let stream: ReturnType<typeof useChapterStream>;
let viewport: HTMLDivElement, stack: HTMLDivElement;
let pageDocument: EventTarget & {hidden: boolean; visibilityState: string}, pageWindow: EventTarget;
const update = vi.fn((next: ReadingEntry) => {if (entry.id === next.id) entry = next; sequence = sequence.map(item => item.id === next.id ? next : item); hooks.dirty = true;});
let onUpdate: (next: ReadingEntry) => void;
const onLoadEntry = vi.fn(), onActiveEntry = vi.fn((id: string) => {entry = sequence.find(item => item.id === id)!; hooks.dirty = true;}), onMarkRead = vi.fn(async () => {}), notify = vi.fn();

function render() {
  let remaining = 20;
  do {
    if (!remaining--) throw Error('Stream did not settle');
    hooks.state = hooks.ref = hooks.memo = hooks.effect = 0; hooks.dirty = false;
    stream = useChapterStream({copy: entry, sequence, layout, update: onUpdate, onActiveEntry, onLoadEntry, onMarkRead, notify});
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
  mounted = false; onUpdate = update; layout = 'continuous'; onLoadEntry.mockReset();
  for (const callback of [update, onLoadEntry, onActiveEntry, onMarkRead, notify]) callback.mockClear();
  vi.useFakeTimers(); vi.setSystemTime(10000);
  pageDocument = Object.assign(new EventTarget(), {hidden: false, visibilityState: 'visible'}); pageWindow = new EventTarget();
  vi.stubGlobal('document', pageDocument); vi.stubGlobal('window', pageWindow);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  viewport = {scrollTop: 0, clientTop: 0, clientHeight: 800, scrollHeight: pageHeight * 2, getBoundingClientRect: () => ({top: 0})} as unknown as HTMLDivElement;
  stack = {getBoundingClientRect: () => ({top: -viewport.scrollTop})} as unknown as HTMLDivElement;
});

describe('backward chapter navigation', () => {
  function preceding(complete = true) {
    const previous = {...entry, id: 'previous', contentId: 'previous-content', pageId: 'previous-0', relativeOffset: .75,
      discoveryComplete: complete, pages: complete ? entry.pages.map((page, n) => ({...page, id: `previous-${n}`})) : []};
    sequence = [previous, entry]; render(); return previous;
  }
  async function loaded() {for (let n = 0; n < 6; n++) await Promise.resolve(); render();}
  it.each(['single', 'double', 'continuous'] as const)('returns to the preceding chapter end in %s and preserves the chapter being left', async mode => {
    layout = mode; mount(.25, false); const previous = preceding();
    stream.jump(-1); render(); await loaded();
    expect(entry.id).toBe(previous.id); expect(stream.index).toBe(1);
    expect(stream.anchor.current).toEqual({entryId: previous.id, pageId: 'previous-1', relativeOffset: 0});
    expect(update.mock.calls[0][0]).toMatchObject({id: 'long-chapter', pageId: 'page-0', relativeOffset: .25});
    expect(onMarkRead).not.toHaveBeenCalled();
    expect(entry).toMatchObject({pageId: 'previous-1', relativeOffset: 0});
    const saves = update.mock.calls.length; leave('pagehide'); expect(update).toHaveBeenCalledTimes(saves);
    stream.jump(2); render(); expect(entry.id).toBe('long-chapter'); expect(stream.index).toBe(0);
  });
  it('keeps the first chapter bounded without wrapping', () => {
    layout = 'single'; mount(0, false); expect(stream.previous).toBeUndefined();
    stream.jump(-1); render(); expect(entry.id).toBe('long-chapter'); expect(stream.index).toBe(0); expect(onActiveEntry).not.toHaveBeenCalled();
  });
  it('loads an unknown preceding manifest on demand and resolves its actual last page', async () => {
    layout = 'single'; mount(0, false); const previous = preceding(false);
    expect(onLoadEntry).not.toHaveBeenCalled();
    onLoadEntry.mockImplementation(async id => {
      if (id !== previous.id) return;
      update({...entry, discoveryComplete: true, pages: [0, 1, 2].map(n => ({id: `loaded-${n}`, name: String(n), width: 800, height: 1200, jobs: [], outputBlobs: {}}))});
    });
    stream.jump(-1); render(); await loaded();
    expect(onLoadEntry).toHaveBeenCalledWith(previous.id, expect.objectContaining({speculative: false}));
    expect(stream.index).toBe(2); expect(stream.anchor.current.pageId).toBe('loaded-2');
  });
  it('uses a refreshed last page when retained descriptors are replaced', async () => {
    layout = 'double'; mount(0, false); const previous = preceding();
    onLoadEntry.mockImplementation(async id => {
      if (id === previous.id) update({...entry, generation: 2, pages: previous.pages.map(page => ({...page, id: `new-${page.id}`}))});
    });
    stream.jump(-1); render(); await loaded(); await loaded();
    expect(stream.index).toBe(1); expect(stream.anchor.current.pageId).toBe('new-previous-1');
  });
  it('keeps cached pages readable after a refresh failure', async () => {
    layout = 'single'; mount(0, false); preceding(); onLoadEntry.mockRejectedValue(Error('Offline'));
    stream.jump(-1); render(); await loaded();
    expect(stream.resources.ready(entry)).toBe(true); expect(stream.index).toBe(1); expect(stream.anchor.current.pageId).toBe('previous-1');
  });
  it('does not jump to the tail after the user has chosen another page', async () => {
    layout = 'single'; mount(0, false); const previous = preceding();
    let finish!: () => void; onLoadEntry.mockImplementation(() => new Promise<void>(resolve => {finish = resolve;}));
    stream.jump(-1); render(); await loaded(); stream.jump(0); render(); finish(); await loaded();
    expect(entry.id).toBe(previous.id); expect(stream.index).toBe(0); expect(stream.anchor.current.pageId).toBe('previous-0');
  });
  it('does not apply a late preceding manifest after leaving the chapter', async () => {
    layout = 'single'; mount(0, false); const previous = preceding(false);
    let finish!: () => void; onLoadEntry.mockImplementation(id => id === previous.id ? new Promise<void>(resolve => {finish = resolve;}) : undefined);
    stream.jump(-1); render(); await loaded();
    entry = sequence[1]; render(); finish(); await loaded();
    expect(entry.id).toBe('long-chapter'); expect(stream.index).toBe(0); expect(stream.anchor.current.pageId).toBe('page-0');
  });
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
