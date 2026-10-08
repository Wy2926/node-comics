import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {FocusEvent, KeyboardEvent, PointerEvent} from 'react';

// Run the shared image/EPUB chrome hook with real fake-timer scheduling.
// Browser focus-visible semantics are additionally checked in the local reader.
const hooks = vi.hoisted(() => ({
  state: 0, ref: 0, effect: 0, dirty: false,
  states: [] as unknown[], refs: [] as {current: unknown}[],
  effects: [] as {deps: unknown[]; cleanup?: () => void}[], pending: [] as (() => void)[],
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: <T,>(initial?: T) => {
    const index = hooks.state++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: T | ((previous: T) => T)) => {
      const value = typeof next === 'function' ? (next as (previous: T) => T)(hooks.states[index] as T) : next;
      if (!Object.is(value, hooks.states[index])) hooks.dirty = true;
      hooks.states[index] = value;
    }];
  },
  useRef: (initial: unknown) => hooks.refs[hooks.ref++] ??= {current: initial},
  useEffect: (callback: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.effect++, previous = hooks.effects[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = {deps, cleanup: callback() || undefined};
    });
  },
}));
import {useReaderControls} from '../src/reader/useReaderControls';
import {ReaderShell, dismissReaderKeyboard} from '../src/reader/ReaderChrome';

let blocked: boolean, focusVisible: boolean;
const focus = vi.fn();
const querySelector = vi.fn((selector: string) => selector === '.nc-reader-controls :focus-visible'
  ? focusVisible ? {focus} : null : selector === '[data-reader-settings-trigger]' ? {focus} : null);
let controls: ReturnType<typeof useReaderControls<'settings' | 'directory' | 'translation'>>;
function render() {
  do {
    hooks.state = hooks.ref = hooks.effect = 0;
    hooks.dirty = false;
    controls = useReaderControls({blocked, notify: vi.fn()});
    controls.root.current = {querySelector} as unknown as HTMLDivElement;
    while (hooks.pending.length) hooks.pending.shift()!();
  } while (hooks.dirty);
  return controls;
}
function shell() {
  return ReaderShell({...controls, ref: controls.root, background: 'gray', children: null}).props;
}
function advance(ms = 1200) {vi.advanceTimersByTime(ms); render();}
function enable() {controls.setImmersive(true); render();}
function cleanup() {for (const effect of hooks.effects) effect.cleanup?.();}
const target = (inControls: boolean) => ({closest: vi.fn(() => inControls ? {} : null)});

beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = [];
  blocked = focusVisible = false;
  focus.mockClear(); querySelector.mockClear();
  vi.useFakeTimers();
  vi.stubGlobal('document', {querySelector: () => null, addEventListener: vi.fn(), removeEventListener: vi.fn()});
  vi.stubGlobal('window', {addEventListener: vi.fn(), removeEventListener: vi.fn()});
  render();
});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('reader numeric keyboard', () => {
  it.each([
    {key: 'Enter', composing: false, keyCode: 13, dismiss: true},
    {key: 'Enter', composing: true, keyCode: 13, dismiss: false},
    {key: 'Enter', composing: false, keyCode: 229, dismiss: false},
    {key: 'ArrowRight', composing: false, keyCode: 39, dismiss: false},
  ])('dismisses only a completed Done key: %j', ({key, composing, keyCode, dismiss}) => {
    const blur = vi.fn(), preventDefault = vi.fn();
    dismissReaderKeyboard({key, nativeEvent: {isComposing: composing, keyCode}, currentTarget: {blur}, preventDefault} as unknown as KeyboardEvent<HTMLInputElement>);
    expect(blur).toHaveBeenCalledTimes(Number(dismiss));
    expect(preventDefault).toHaveBeenCalledTimes(Number(dismiss));
  });
});

describe('immersive reader controls', () => {
  it('hides after 1200ms and does not restart for unrelated renders', () => {
    enable(); advance(1000); render();
    expect(controls.hidden).toBe(false);
    advance(199); expect(controls.hidden).toBe(false);
    advance(1); expect(controls.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hides after mouse closing settings even when focus returns to its trigger', () => {
    controls.setPanel('settings'); render(); enable(); advance(5000);
    expect(controls.hidden).toBe(false); expect(vi.getTimerCount()).toBe(0);
    controls.closePanel(); render();
    expect(focus).toHaveBeenCalledWith({preventScroll: true});
    expect(vi.getTimerCount()).toBe(1);
    advance(); expect(controls.hidden).toBe(true);
    expect(querySelector).toHaveBeenCalledWith('.nc-reader-controls :focus-visible');
  });

  it('protects keyboard/input focus, then resumes from blur without a blank-area click', () => {
    focusVisible = true; enable(); advance(5000);
    expect(controls.hidden).toBe(false); expect(vi.getTimerCount()).toBe(0);
    shell().onBlurCapture!({target: target(true)} as unknown as FocusEvent<HTMLDivElement>);
    focusVisible = false; render();
    advance(1199); expect(controls.hidden).toBe(false);
    advance(1); expect(controls.hidden).toBe(true);
  });

  it('rechecks keyboard focus when it moves between controls before the timer fires', () => {
    enable(); advance(1000);
    focusVisible = true;
    shell().onFocusCapture!({target: target(true)} as unknown as FocusEvent<HTMLDivElement>);
    advance(5000); expect(controls.hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rearms on pointer use of an already focused button, even without a new focus event', () => {
    focusVisible = true; enable(); advance();
    shell().onPointerDownCapture!({target: target(true)} as unknown as PointerEvent<HTMLDivElement>);
    focusVisible = false; render(); advance();
    expect(controls.hidden).toBe(true);
  });

  it('reveal replaces the pending timeout instead of accumulating timers', () => {
    enable(); advance(900);
    for (let i = 0; i < 30; i++) controls.reveal();
    render(); expect(vi.getTimerCount()).toBe(1);
    advance(1199); expect(controls.hidden).toBe(false);
    advance(1); expect(controls.hidden).toBe(true);
    controls.reveal(); render(); expect(controls.hidden).toBe(false);
  });

  it.each(['panel', 'blocked', 'disabled'] as const)('cancels hiding while %s and restarts only when allowed', reason => {
    enable(); advance(900);
    if (reason === 'panel') controls.togglePanel('directory');
    else if (reason === 'blocked') blocked = true;
    else controls.setImmersive(false);
    render(); advance(5000);
    expect(controls.hidden).toBe(false); expect(vi.getTimerCount()).toBe(0);
    if (reason === 'panel') controls.setPanel(undefined);
    else if (reason === 'blocked') blocked = false;
    else controls.setImmersive(true);
    render(); advance(); expect(controls.hidden).toBe(true);
  });

  it('cleans up the timer on unmount', () => {
    enable(); expect(vi.getTimerCount()).toBe(1);
    cleanup(); expect(vi.getTimerCount()).toBe(0);
  });

  it('has no pointer/focus handlers outside immersive mode and avoids layout reads over controls', () => {
    expect(shell().onPointerMove).toBeUndefined();
    expect(shell().onPointerDownCapture).toBeUndefined();
    expect(shell().onFocusCapture).toBeUndefined();
    expect(shell().onBlurCapture).toBeUndefined();
    enable();
    const bounds = vi.fn(() => ({left: 0, right: 1000}));
    shell().onPointerMove!({target: target(true), currentTarget: {getBoundingClientRect: bounds}} as unknown as PointerEvent<HTMLDivElement>);
    expect(bounds).not.toHaveBeenCalled();
    advance(); expect(controls.hidden).toBe(true);
    shell().onPointerMove!({target: target(false), currentTarget: {getBoundingClientRect: bounds}, clientX: 4} as unknown as PointerEvent<HTMLDivElement>);
    render(); expect(controls.hidden).toBe(false);
    expect(bounds).toHaveBeenCalledOnce();
  });

  it('does not reopen tools or measure the canvas while a touch scroll passes an edge', () => {
    enable(); advance();
    const bounds = vi.fn(() => ({left: 0, right: 390}));
    shell().onPointerMove!({pointerType: 'touch', target: target(false), currentTarget: {getBoundingClientRect: bounds}, clientX: 2} as unknown as PointerEvent<HTMLDivElement>);
    render();
    expect(controls.hidden).toBe(true);
    expect(bounds).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
