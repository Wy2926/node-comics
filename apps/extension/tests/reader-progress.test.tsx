import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const hooks = vi.hoisted(() => ({cursor: 0, states: [] as any[], refs: [] as any[], refCursor: 0, effectCursor: 0, effects: [] as any[], pending: [] as (() => void)[]}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const index = hooks.cursor++; if (!(index in hooks.states)) hooks.states[index] = initial; return [hooks.states[index], (next: unknown) => {hooks.states[index] = next;}];},
  useRef: (current: unknown) => hooks.refs[hooks.refCursor++] ?? (hooks.refs[hooks.refCursor - 1] = {current}),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.effectCursor++, previous = hooks.effects[index];
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    hooks.pending.push(() => {previous?.cleanup?.(); hooks.effects[index] = {deps, cleanup: effect()};});
  },
}));
vi.mock('react-dom', () => ({createPortal: (node: unknown) => node}));
import {ReaderProgress, progressPreviewPosition} from '../src/reader/ReaderProgress';
type Props = Parameters<typeof ReaderProgress>[0];
let props: Props;
const bounds = {left: 32, right: 60, top: 200, bottom: 440, width: 28, height: 240} as DOMRect;
const input = {closest: () => ({}), getBoundingClientRect: vi.fn(() => bounds)};
function render() {
  hooks.cursor = hooks.refCursor = hooks.effectCursor = 0;
  const node = ReaderProgress(props);
  hooks.pending.splice(0).forEach(effect => effect());
  return node.props.children[0].props;
}
function change(value: number) {render().onChange({currentTarget: {value: String(value)}});}
function down(pointerId = 1) {render().onPointerDown({button: 0, isPrimary: true, pointerId, currentTarget: input});}
function up(pointerId = 1) {render().onPointerUp({pointerId});}
function key(key: string) {return {key, currentTarget: input, preventDefault: vi.fn(), stopPropagation: vi.fn()};}
beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = [];
  input.getBoundingClientRect.mockClear();
  vi.stubGlobal('window', Object.assign(new EventTarget(), {innerWidth: 1200, innerHeight: 900})); vi.stubGlobal('document', Object.assign(new EventTarget(), {hidden: false}));
  props = {value: 3, min: 1, max: 120, valueText: value => `Page ${value}`, onCommit: vi.fn()}; render();
});
afterEach(() => {hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals();});

describe('reader progress destinations', () => {
  it('previews a 100-step drag locally and commits only its final page', () => {
    down(); for (let page = 4; page <= 103; page++) change(page);
    expect(render()).toMatchObject({value: 103, 'aria-valuetext': 'Page 103'});
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(input.getBoundingClientRect).toHaveBeenCalledOnce();
    up(); render().onBlur();
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(103);
  });
  it('finishes a release outside the range without overriding native pointer capture', () => {
    const capture = vi.fn(); render().onPointerDown({button: 0, isPrimary: true, pointerId: 1, currentTarget: {...input, setPointerCapture: capture}});
    expect(capture).not.toHaveBeenCalled(); change(40);
    window.dispatchEvent(Object.assign(new Event('pointerup'), {pointerId: 1}));
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(40);
  });
  it('does not navigate when the drag returns to its starting page', () => {down(); change(10); change(3); up(); expect(props.onCommit).not.toHaveBeenCalled();});
  it('commits a track tap on release and ignores a different pointer release', () => {down(); change(70); up(2); expect(props.onCommit).not.toHaveBeenCalled(); up(); expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(70);});
  it.each(['cancel', 'blur', 'escape', 'window-blur', 'resize', 'scroll', 'hidden'])('abandons a %s gesture without a late jump', reason => {
    down(); change(55);
    if (reason === 'cancel') render().onPointerCancel();
    if (reason === 'blur') render().onBlur();
    if (reason === 'escape') {const event = key('Escape'); render().onKeyDown(event); expect(event.preventDefault).toHaveBeenCalledOnce();}
    if (reason === 'resize' || reason === 'scroll') window.dispatchEvent(new Event(reason));
    if (reason === 'window-blur') window.dispatchEvent(new Event('blur'));
    if (reason === 'hidden') {Object.assign(document, {hidden: true}); document.dispatchEvent(new Event('visibilitychange'));}
    change(70); up(); expect(props.onCommit).not.toHaveBeenCalled(); expect(render().value).toBe(3);
    down(); change(20); up(); expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(20);
  });
  it.each(['ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])('commits held %s once at key release', name => {
    for (let page = 4; page <= 20; page++) {render().onKeyDown(key(name)); change(page);}
    expect(props.onCommit).not.toHaveBeenCalled(); render().onKeyUp(key(name));
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(20);
  });
  it('lets Escape cancel a held key without committing on its later keyup', () => {
    render().onKeyDown(key('ArrowRight')); change(7); render().onKeyDown(key('Escape')); change(8); render().onKeyUp(key('ArrowRight'));
    expect(props.onCommit).not.toHaveBeenCalled();
  });
  it.each(['value', 'max', 'disabled'] as const)('invalidates the draft when external %s changes', field => {
    down(); change(20); Object.assign(props, {[field]: field === 'disabled' ? true : 4}); render(); up();
    expect(props.onCommit).not.toHaveBeenCalled();
  });
  it('accepts an assistive change with no pointer or keyboard session', () => {change(16); expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(16);});
  it('does not submit an unfinished gesture during unmount', () => {down(); change(20); hooks.effects.forEach(effect => effect.cleanup?.()); expect(props.onCommit).not.toHaveBeenCalled();});
  it('retains the EPUB zero-percent boundary', () => {props = {...props, min: 0, max: 100, percentage: true}; render(); down(); change(0); up(); expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(0);});
});

it('keeps the lens inside narrow screens and anchored at both track ends', () => {
  const horizontal = {left: 60, right: 260, top: 60, bottom: 104, width: 200, height: 44} as DOMRect;
  const first = progressPreviewPosition({bounds: horizontal, width: 320, height: 568}, 1, 1, 120);
  const last = progressPreviewPosition({bounds: horizontal, width: 320, height: 568}, 120, 1, 120);
  expect(first).toEqual({vertical: false, left: 12, top: 128, offset: 60});
  expect(last).toEqual({vertical: false, left: 156, top: 128, offset: 92});
  expect(progressPreviewPosition({bounds, width: 1200, height: 900}, 1, 1, 120)).toEqual({vertical: true, left: 84, top: 146, offset: 66});
});
