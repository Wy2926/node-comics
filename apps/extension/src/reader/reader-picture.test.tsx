import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {isValidElement, type ReactNode} from 'react';

const hooks = vi.hoisted(() => ({state: 0, ref: 0, effect: 0, dirty: false,
  states: [] as unknown[], refs: [] as {current: unknown}[],
  effects: [] as {deps: unknown[]; cleanup?: () => void}[], pending: [] as (() => void)[],
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: <T,>(initial?: T | (() => T)) => {
    const at = hooks.state++;
    if (!(at in hooks.states)) hooks.states[at] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.states[at], (next: T | ((previous: T) => T)) => {
      const value = typeof next === 'function' ? (next as (previous: T) => T)(hooks.states[at] as T) : next;
      if (!Object.is(value, hooks.states[at])) hooks.dirty = true;
      hooks.states[at] = value;
    }];
  },
  useRef: (value: unknown) => hooks.refs[hooks.ref++] ??= {current: value},
  useCallback: <T,>(value: T) => value,
  useEffect: effect,
  useLayoutEffect: effect,
}));
function effect(callback: () => void | (() => void), deps: unknown[]) {
  const at = hooks.effect++, previous = hooks.effects[at];
  if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) hooks.pending.push(() => {
    previous?.cleanup?.(); hooks.effects[at] = {deps, cleanup: callback() || undefined};
  });
}
vi.mock('./prepare-image', () => ({prepareReaderImage: vi.fn(async (_url: string, signal: AbortSignal) => signal.throwIfAborted())}));
import {ReaderPicture, type ReaderPictureProps} from './ReaderPicture';

let options: ReaderPictureProps;
let tree: ReactNode;
function render(change: Partial<ReaderPictureProps> = {}) {
  options = {...options, ...change};
  let runs = 0;
  do {
    if (++runs > 20) throw Error('Unexpected reader render loop');
    hooks.state = hooks.ref = hooks.effect = 0; hooks.dirty = false;
    tree = ReaderPicture(options);
    while (hooks.pending.length) hooks.pending.shift()!();
  } while (hooks.dirty);
}
async function flush() {for (let n = 0; n < 5; n++) await Promise.resolve(); render();}
function images(node: ReactNode): {src: string; className: string; onLoad(event: unknown): void}[] {
  if (Array.isArray(node)) return node.flatMap(child => images(child));
  if (!isValidElement<{children?: ReactNode; src: string; className: string; onLoad(event: unknown): void}>(node)) return [];
  return node.type === 'img' ? [node.props] : images(node.props.children);
}
function displayed() {const image = images(tree).find(image => image.className === 'nc-page-image-pending'); expect(image).toBeDefined(); image!.onLoad({currentTarget: {naturalWidth: 800, naturalHeight: 1200}}); render();}
function cleanup() {for (const effect of hooks.effects) effect?.cleanup?.(); hooks.effects = [];}
beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = [];
  let id = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:reader-test-${++id}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  options = {scope: 'slot-1', blobKey: 'original', alt: 'Page 1', onImport: vi.fn(), hideSourceActions: true,
    acquire: vi.fn(async () => ({blob: new Blob(['image']), release: vi.fn()}))};
});
afterEach(() => {cleanup(); vi.restoreAllMocks();});

describe('shared reader pixel presentation', () => {
  it('commits only after the actual display loads and releases its URL and source lease on removal', async () => {
    const release = vi.fn(), shown = vi.fn(), dimensions = vi.fn();
    render({acquire: vi.fn(async () => ({blob: new Blob(['image']), release})), onShown: shown, onDimensions: dimensions});
    await flush();
    expect(shown.mock.calls.some(([value]) => value?.key === 'original')).toBe(false);
    displayed();
    expect(shown).toHaveBeenCalledWith(expect.objectContaining({key: 'original'}));
    expect(dimensions).toHaveBeenCalledExactlyOnceWith(800, 1200);
    cleanup();
    expect(release).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:reader-test-1');
  });
  it('keeps the previous displayed image while a replacement fails', async () => {
    render(); await flush(); displayed();
    render({blobKey: 'translated', acquire: vi.fn(async () => {throw Error('result unavailable');})});
    await flush();
    expect(images(tree).map(image => image.src)).toEqual(['blob:reader-test-1']);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:reader-test-1');
    cleanup(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reader-test-1');
  });
  it('releases displayed pixels when hidden by unmount and loads a fresh image when shown again', async () => {
    const release=vi.fn(),acquire=vi.fn(async()=>({blob:new Blob(['image']),release}));
    render({acquire});await flush();displayed();
    expect(images(tree).map(image=>image.src)).toEqual(['blob:reader-test-1']);
    cleanup();
    expect(release).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:reader-test-1');
    // SessionPicture keeps its page frame but mounts a new ReaderPicture after visibility returns.
    hooks.states=[];hooks.refs=[];hooks.pending=[];
    render();await flush();displayed();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(images(tree).map(image=>image.src)).toEqual(['blob:reader-test-2']);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:reader-test-2');
    cleanup();
    expect(release).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reader-test-2');
  });
  it('aborts hidden work and releases a lease that arrives after unmount without making a URL', async () => {
    let finish!: (lease: {blob: Blob; release(): void}) => void;
    let signal!: AbortSignal;
    const release = vi.fn();
    render({acquire: vi.fn((_key: string, incoming: AbortSignal) => {signal = incoming; return new Promise<{blob: Blob; release(): void}>(resolve => {finish = resolve;});})});
    cleanup(); expect(signal.aborted).toBe(true);
    finish({blob: new Blob(['late']), release});
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('does not start a hidden image and aborts an active read when it becomes hidden', async () => {
    let signal!: AbortSignal;
    const acquire = vi.fn((_key: string, incoming: AbortSignal) => {signal = incoming; return new Promise<{blob: Blob; release(): void}>(() => {});});
    render({acquire, defer: true}); expect(acquire).not.toHaveBeenCalled();
    render({defer: false}); expect(acquire).toHaveBeenCalledOnce();
    render({defer: true}); expect(signal.aborted).toBe(true);
  });
});
