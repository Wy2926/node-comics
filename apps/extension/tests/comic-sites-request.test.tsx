import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactNode} from 'react';
import {ComicSites} from '../src/ui/ComicSites';

const {effects, section, input} = vi.hoisted(() => {
  const input = {focus: vi.fn()};
  return {effects: [] as (() => void | (() => void))[], input,
    section: {scrollIntoView: vi.fn(), querySelector: vi.fn(() => input)}};
});
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useRef: () => ({current: section}),
  useCallback: (callback: () => void) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));
vi.mock('../src/sources', () => ({listSupportedSites: () => [], sortSupportedSites: () => [], matchesSiteFilters: vi.fn(), safeImageUrl: vi.fn()}));
vi.mock('../src/ui/SupportRequestForm', () => ({SupportRequestForm: () => null}));

type Click = {button: number; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; preventDefault: () => void};
function findShortcut(node: ReactNode): {onClick: (event: Click) => void} | undefined {
  if (Array.isArray(node)) return node.map(findShortcut).find(Boolean);
  if (!isValidElement<{className?: string; children?: ReactNode; onClick: (event: Click) => void}>(node)) return;
  return node.props.className?.includes('nc-site-request-shortcut') ? node.props : findShortcut(node.props.children);
}
function mount(hash: string) {
  const url = new URL('https://fixture.test/' + hash), target = new EventTarget();
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('location', url);
  vi.stubGlobal('window', target);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {frames.set(++sequence, callback); return sequence;});
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const shortcut = findShortcut(ComicSites({}))!;
  const dispose = effects.at(-1)!() as () => void;
  return {url, target, shortcut, dispose, flush() {const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0));}};
}
beforeEach(() => {effects.length = 0; vi.clearAllMocks();});
afterEach(() => vi.unstubAllGlobals());

it('keeps initial hash navigation and relocates on every repeated click without a hashchange', () => {
  const fixture = mount('#sites'), preventDefault = vi.fn();
  fixture.shortcut.onClick({button: 0, preventDefault});
  expect(preventDefault).not.toHaveBeenCalled();
  fixture.url.hash = '#sites/request';
  fixture.target.dispatchEvent(new Event('hashchange'));
  fixture.flush();
  expect(section.scrollIntoView).toHaveBeenCalledTimes(1);
  // Scrolling away leaves the same hash: each click must locate the form again.
  fixture.shortcut.onClick({button: 0, preventDefault});
  fixture.shortcut.onClick({button: 0, preventDefault});
  expect(preventDefault).toHaveBeenCalledTimes(2);
  expect(section.scrollIntoView).toHaveBeenCalledTimes(3);
  expect(section.scrollIntoView).toHaveBeenLastCalledWith({block: 'center'});
  expect(input.focus).toHaveBeenCalledTimes(3);
  expect(input.focus).toHaveBeenLastCalledWith({preventScroll: true});
  fixture.dispose();
});

it('preserves direct links and cancels pending navigation when leaving or unmounting', () => {
  const fixture = mount('#sites/request');
  fixture.flush();
  expect(section.scrollIntoView).toHaveBeenCalledOnce();
  fixture.target.dispatchEvent(new Event('hashchange'));
  fixture.url.hash = '#sites';
  fixture.flush();
  fixture.url.hash = '#sites/request';
  fixture.target.dispatchEvent(new Event('hashchange'));
  fixture.dispose();
  fixture.flush();
  fixture.target.dispatchEvent(new Event('hashchange'));
  fixture.flush();
  expect(section.scrollIntoView).toHaveBeenCalledOnce();
});

it.each([{button: 1}, {button: 0, ctrlKey: true}, {button: 0, metaKey: true}, {button: 0, shiftKey: true}, {button: 0, altKey: true}])('does not intercept modified link activation: %o', modifiers => {
  const fixture = mount('#sites/request'), preventDefault = vi.fn();
  fixture.shortcut.onClick({...modifiers, preventDefault});
  expect(preventDefault).not.toHaveBeenCalled();
  expect(section.scrollIntoView).not.toHaveBeenCalled();
  fixture.dispose();
});
