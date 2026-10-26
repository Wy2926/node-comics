import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {FocusEvent, PointerEvent} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

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
import {ReaderShell} from '../src/reader/ReaderChrome';
import {defaults, type Settings} from '../src/types';

let blocked: boolean, focusVisible: boolean, active: boolean, hovered: boolean, finePointer: boolean, compact: boolean;
let settings: Settings;
const focus = vi.fn();
const querySelector = vi.fn((selector: string) => selector === '.nc-reader-controls :focus-visible, .nc-reader-controls :active'
  ? focusVisible || active ? {focus} : null : selector === '.nc-reader-controls:hover'
    ? hovered ? {} : null : selector === '[data-reader-settings-trigger]' ? {focus} : null);
let controls: ReturnType<typeof useReaderControls<'settings' | 'directory' | 'translation'>>;
function render() {
  do {
    hooks.state = hooks.ref = hooks.effect = 0;
    hooks.dirty = false;
    controls = useReaderControls({blocked, notify: vi.fn(), settings, setSettings: value => {
      settings = typeof value === 'function' ? value(settings) : value;
      hooks.dirty = true;
    }});
    controls.root.current = {querySelector} as unknown as HTMLDivElement;
    while (hooks.pending.length) hooks.pending.shift()!();
  } while (hooks.dirty);
  return controls;
}
function shell() {
  return ReaderShell({...controls, ref: controls.root, background: 'gray', children: null}).props;
}
function advance(ms = 6000) {vi.advanceTimersByTime(ms); render();}
function enable() {controls.setImmersive(true); render();}
function cleanup() {for (const effect of hooks.effects) effect.cleanup?.();}
const target = (inControls: boolean) => ({closest: vi.fn(() => inControls ? {} : null)});

beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = [];
  settings = {...defaults};
  blocked = focusVisible = active = hovered = finePointer = compact = false;
  focus.mockClear(); querySelector.mockClear();
  vi.useFakeTimers();
  vi.stubGlobal('document', {querySelector: () => null, addEventListener: vi.fn(), removeEventListener: vi.fn()});
  vi.stubGlobal('window', {addEventListener: vi.fn(), removeEventListener: vi.fn(), matchMedia: (query: string) => ({matches: query.includes('pointer: fine') ? finePointer : compact})});
  render();
});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('immersive reader controls', () => {
  it('enters fullscreen for the whole reader document and exits the active fullscreen view', async () => {
    const requestFullscreen = vi.fn(async () => {}), exitFullscreen = vi.fn(async () => {});
    Object.assign(document, {documentElement: {requestFullscreen}, fullscreenElement: null, exitFullscreen});
    await controls.fullscreen();
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(exitFullscreen).not.toHaveBeenCalled();
    Object.assign(document, {fullscreenElement: {}});
    await controls.fullscreen();
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });

  it('defaults to immersive with a visible, auto-hiding first-use toolbar', () => {
    expect(controls.immersive).toBe(true);
    expect(controls.hidden).toBe(false);
    expect(shell().className).toContain('is-immersive');
    advance(); expect(controls.hidden).toBe(true);
  });

  it('retains the disabled preference when image or EPUB controls remount', () => {
    controls.setImmersive(false); render();
    expect(settings).toEqual({...defaults, readerImmersive: false});
    cleanup(); hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = [];
    render(); advance(10000);
    expect(controls.immersive).toBe(false);
    expect(controls.hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the latest shared preference and cancels hiding when another reader disables immersion', () => {
    advance(1000);
    settings = {...settings, readerImmersive: false}; render(); advance(10000);
    expect(controls.hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    controls.setImmersive(previous => !previous); render();
    expect(settings.readerImmersive).toBe(true);
    advance(); expect(controls.hidden).toBe(true);
  });

  it.each([true, false].flatMap(immersive => [true, false].map(hidden => ({immersive, hidden}))))(
    'never renders a floating settings/reveal button (immersive: $immersive, hidden: $hidden)', ({immersive, hidden}) => {
      const markup = renderToStaticMarkup(<ReaderShell {...controls} ref={controls.root} background="gray"
        immersive={immersive} hidden={hidden}><main>Reader content</main></ReaderShell>);
      expect(markup).toContain('<main>Reader content</main>');
      expect(markup).not.toContain('<button');
      expect(markup).not.toContain('nc-reveal');
    },
  );

  it('reveals hidden tools with Escape without requiring a floating button', () => {
    advance(); expect(controls.hidden).toBe(true);
    const escape = vi.mocked(window.addEventListener).mock.calls.find(([type]) => type === 'keydown')![1] as (event: globalThis.KeyboardEvent) => void;
    escape({key: 'Escape', defaultPrevented: false, isComposing: false, keyCode: 27} as globalThis.KeyboardEvent);
    render();
    expect(controls.hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('toggles tools on content taps without leaving a hide timer running', () => {
    controls.toggleControls(); render();
    expect(controls.hidden).toBe(true); expect(vi.getTimerCount()).toBe(0);
    controls.toggleControls(); render();
    expect(controls.hidden).toBe(false); expect(vi.getTimerCount()).toBe(1);
    advance(); expect(controls.hidden).toBe(true);
  });

  it.each(['panel', 'blocked', 'disabled'] as const)('content taps respect %s', reason => {
    if (reason === 'panel') controls.setPanel('settings');
    else if (reason === 'blocked') blocked = true;
    else controls.setImmersive(false);
    render(); controls.toggleControls(); render();
    expect(controls.panel).toBeUndefined();
    expect(controls.hidden).toBe(false);
    advance(10000); expect(controls.hidden).toBe(reason === 'panel');
  });

  it('hides after 6000ms and does not restart for unrelated renders', () => {
    enable(); advance(1000); render();
    expect(controls.hidden).toBe(false);
    advance(4999); expect(controls.hidden).toBe(false);
    advance(1); expect(controls.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hides after mouse closing settings even when focus returns to its trigger', () => {
    controls.setPanel('settings'); render(); enable(); advance(10000);
    expect(controls.hidden).toBe(false); expect(vi.getTimerCount()).toBe(0);
    controls.closePanel(); render();
    expect(focus).toHaveBeenCalledWith({preventScroll: true});
    expect(vi.getTimerCount()).toBe(1);
    advance(); expect(controls.hidden).toBe(true);
    expect(querySelector).toHaveBeenCalledWith('.nc-reader-controls :focus-visible, .nc-reader-controls :active');
  });

  it('protects keyboard/input focus, then resumes from blur without a blank-area click', () => {
    focusVisible = true; enable(); advance(10000);
    expect(controls.hidden).toBe(false); expect(vi.getTimerCount()).toBe(0);
    shell().onBlurCapture!({target: target(true)} as unknown as FocusEvent<HTMLDivElement>);
    focusVisible = false; render();
    advance(5999); expect(controls.hidden).toBe(false);
    advance(1); expect(controls.hidden).toBe(true);
  });

  it('rechecks keyboard focus when it moves between controls before the timer fires', () => {
    enable(); advance(1000);
    focusVisible = true;
    shell().onFocusCapture!({target: target(true)} as unknown as FocusEvent<HTMLDivElement>);
    advance(10000); expect(controls.hidden).toBe(false);
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
    advance(5999); expect(controls.hidden).toBe(false);
    advance(1); expect(controls.hidden).toBe(true);
    controls.reveal(); render(); expect(controls.hidden).toBe(false);
  });

  it.each(['panel', 'blocked', 'disabled'] as const)('cancels hiding while %s and restarts only when allowed', reason => {
    enable(); advance(900);
    if (reason === 'panel') controls.togglePanel('directory');
    else if (reason === 'blocked') blocked = true;
    else controls.setImmersive(false);
    render(); advance(10000);
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

  it.each(['onPointerUpCapture', 'onPointerCancelCapture'] as const)('keeps a long control press visible, then rearms on %s', handler => {
    active = true;
    shell().onPointerDownCapture!({target: target(true)} as unknown as PointerEvent<HTMLDivElement>);
    advance(10000); expect(controls.hidden).toBe(false); expect(vi.getTimerCount()).toBe(0);
    active = false;
    shell()[handler]!({target: target(true)} as unknown as PointerEvent<HTMLDivElement>);
    advance(); expect(controls.hidden).toBe(true);
  });

  it('keeps stationary mouse hover open and resumes after leaving the toolbar', () => {
    finePointer = hovered = true;
    shell().onPointerOver!({target: target(true)} as unknown as PointerEvent<HTMLDivElement>);
    advance(10000); expect(controls.hidden).toBe(false); expect(vi.getTimerCount()).toBe(0);
    shell().onPointerOut!({target: target(true), relatedTarget: target(true)} as unknown as PointerEvent<HTMLDivElement>);
    expect(vi.getTimerCount()).toBe(0);
    hovered = false;
    shell().onPointerOut!({target: target(true), relatedTarget: target(false)} as unknown as PointerEvent<HTMLDivElement>);
    advance(); expect(controls.hidden).toBe(true);
  });

  it('does not let sticky touch hover pin the toolbar open', () => {
    hovered = true; advance(); expect(controls.hidden).toBe(true);
  });

  it('does not reopen hidden tools when their old mouse focus/hover leaves for a content action', () => {
    advance();
    expect(shell().onBlurCapture).toBeUndefined();
    shell().onPointerOut!({target: target(true), relatedTarget: target(false)} as unknown as PointerEvent<HTMLDivElement>);
    render(); expect(controls.hidden).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('has no pointer/focus handlers outside immersive mode and avoids layout reads over controls', () => {
    controls.setImmersive(false); render();
    expect(shell().onPointerMove).toBeUndefined();
    expect(shell().onPointerDownCapture).toBeUndefined();
    expect(shell().onFocusCapture).toBeUndefined();
    expect(shell().onBlurCapture).toBeUndefined();
    enable();
    const bounds = vi.fn(() => ({left: 0, right: 1000}));
    shell().onPointerMove!({pointerType: 'mouse', target: target(true), currentTarget: {getBoundingClientRect: bounds}} as unknown as PointerEvent<HTMLDivElement>);
    expect(bounds).not.toHaveBeenCalled();
    advance(); expect(controls.hidden).toBe(true);
    shell().onPointerMove!({pointerType: 'mouse', target: target(false), currentTarget: {getBoundingClientRect: bounds}, clientX: 4} as unknown as PointerEvent<HTMLDivElement>);
    render(); expect(controls.hidden).toBe(false);
    expect(bounds).toHaveBeenCalledOnce();
  });

  it('does not measure the canvas or restart timers for visible-toolbar mouse movement', () => {
    const bounds = vi.fn();
    advance(1000);
    for (let i = 0; i < 100; i++) shell().onPointerMove!({pointerType: 'mouse', target: target(false), currentTarget: {getBoundingClientRect: bounds}, clientX: 2} as unknown as PointerEvent<HTMLDivElement>);
    expect(bounds).not.toHaveBeenCalled();
    advance(5000); expect(controls.hidden).toBe(true);
  });

  it('uses the top/bottom edges for compact toolbars instead of the page sides', () => {
    compact = true; advance();
    const bounds = vi.fn(() => ({left: 0, right: 390, top: 0, bottom: 844}));
    const move = (clientX: number, clientY: number) => {shell().onPointerMove!({pointerType: 'mouse', target: target(false), currentTarget: {getBoundingClientRect: bounds}, clientX, clientY} as unknown as PointerEvent<HTMLDivElement>); render();};
    move(2, 400); expect(controls.hidden).toBe(true);
    move(195, 2); expect(controls.hidden).toBe(false);
    advance(); move(195, 842); expect(controls.hidden).toBe(false);
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
