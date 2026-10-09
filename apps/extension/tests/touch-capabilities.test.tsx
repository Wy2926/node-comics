import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Scrollbars} from '../src/ui/Scrollbars';

const cssQueries = (path: string) => [...readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  .matchAll(/@media\s*([^{]+)\{/g)].map(match => match[1].replace(/\s+/g, ''));

const {install, scope, effects} = vi.hoisted(() => ({
  install: vi.fn<() => () => void>(), scope: {}, effects: [] as (() => void | (() => void))[],
}));
vi.mock('../src/ui/scrollbar-controller', () => ({installScrollbars: install}));
vi.mock('react', () => ({
  useRef: () => ({current: {closest: () => scope}}),
  useLayoutEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));

// CSS and JS must handle browsers which expose a fine pointer without hover.
// Keep every existing size constraint: a short mouse-driven desktop is not a phone.
it.each([
  'src/redesign.css', 'src/ui/select.css', 'src/ui/context-menu.css',
  'src/ui/theme/surfaces.css', 'src/ui/notification.css', 'src/ui/login.css',
  'src/inline/display.css', 'src/region/styles.css', 'src/sources/runtime/import-button.css',
  'entrypoints/popup/popup.css', 'src/ui/comic-sites.css', 'src/ui/downloads/downloads.css',
  'src/ui/discovery/discovery.css', 'src/ui/shelf.css', 'src/ui/comic-search/comic-search.css',
  'src/ui/remote-library/remote-library.css',
])('%s preserves geometry when accepting no-hover input', path => {
  const queries = cssQueries(path);
  const touchQueries = queries.filter(query => query.includes('(pointer:coarse)'));
  expect(touchQueries.length).toBeGreaterThan(0);
  for (const query of touchQueries) {
    const branches = query.split(',');
    for (const branch of branches.filter(value => value.includes('(pointer:coarse)'))) {
      expect(branches).toContain(branch.replace('(pointer:coarse)', '(hover:none)'));
    }
  }
});

it.each([
  'src/redesign.css', 'src/ui/theme/surfaces.css', 'src/ui/notification.css', 'src/ui/login.css',
  'src/ui/comic-sites.css', 'src/ui/downloads/downloads.css', 'src/ui/discovery/discovery.css',
  'src/ui/shelf.css', 'src/ui/comic-search/comic-search.css', 'src/ui/remote-library/remote-library.css',
  'src/inline/display.css', 'src/region/styles.css',
])('%s uses the reader breakpoint and bounds short touch layouts to 1000px', path => {
  const reader = readFileSync(new URL('../src/reader/ReaderChrome.tsx', import.meta.url), 'utf8');
  const query = reader.match(/compactReaderQuery = '([^']+)'/)![1].replace(/\s+/g, '');
  const queries = cssQueries(path);
  expect(queries).toContain(query);
  for (const branch of queries.flatMap(value => value.split(','))) {
    if (branch.includes('(max-height:500px)')) expect(branch).toContain('(max-width:1000px)');
  }
});

it.each(['src/ui/touch-controls.css', 'src/ui/select.css', 'src/ui/context-menu.css'])(
  '%s does not mistake a narrow mouse-driven popup for touch input', path => {
    expect(cssQueries(path)).toEqual(['(pointer:coarse),(hover:none)']);
  },
);

it('keeps popup sizing independent of the auto-sized native viewport', () => {
  const css = readFileSync(new URL('../entrypoints/popup/popup.css', import.meta.url), 'utf8');
  const desktop = css.slice(0, css.indexOf('@media'));
  expect(desktop).toContain('width: 420px;');
  expect(desktop).toContain('max-height: 600px;');
  expect(desktop).not.toMatch(/\d(?:d|s|l)?v[wh]/);
  expect(cssQueries('entrypoints/popup/popup.css').filter(query => query.includes('pointer:coarse')))
    .toEqual(['(max-device-width:1000px)and(pointer:coarse),(max-device-width:1000px)and(hover:none)']);
  expect(readFileSync(new URL('../src/ui/select.css', import.meta.url), 'utf8')).not.toContain('.nc-popup');
});

function pointerFixture(pointer: 'fine' | 'coarse', hover: 'hover' | 'none', popover = true) {
  const listeners = new Set<() => void>();
  let query = '';
  const media = {
    get matches() {
      return query.split(',').some(branch => branch.trim() === '(pointer: coarse)' ? pointer === 'coarse'
        : branch.trim() === '(hover: none)' && hover === 'none');
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', vi.fn((value: string) => { query = value; return media; }));
  vi.stubGlobal('HTMLElement', {prototype: {showPopover: popover ? () => {} : undefined}});
  Scrollbars({});
  const dispose = effects.at(-1)!() as () => void;
  return {dispose, listeners, change(next: 'hover' | 'none') {
    hover = next; listeners.forEach(listener => listener());
  }};
}

beforeEach(() => {effects.length = 0; install.mockReset(); install.mockImplementation(() => vi.fn());});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ['fine', 'none', false], ['coarse', 'none', false], ['fine', 'hover', true],
] as const)('uses native scrollbars for pointer=%s hover=%s as appropriate', (pointer, hover, custom) => {
  const fixture = pointerFixture(pointer, hover);
  expect(install).toHaveBeenCalledTimes(custom ? 1 : 0);
  if (custom) expect(install).toHaveBeenCalledWith(scope);
  fixture.dispose();
  expect(fixture.listeners.size).toBe(0);
});

it('removes overlay observers on no-hover input and restores them when a mouse is attached', () => {
  const fixture = pointerFixture('fine', 'hover');
  const firstDispose = install.mock.results[0].value;
  fixture.change('none');
  expect(firstDispose).toHaveBeenCalledOnce();
  expect(install).toHaveBeenCalledOnce();
  fixture.change('hover');
  expect(install).toHaveBeenCalledTimes(2);
  const secondDispose = install.mock.results[1].value;
  fixture.dispose();
  expect(secondDispose).toHaveBeenCalledOnce();
  expect(fixture.listeners.size).toBe(0);
});

it('keeps native scrolling without the Popover API, including after pointer changes', () => {
  const fixture = pointerFixture('fine', 'hover', false);
  fixture.change('none'); fixture.change('hover');
  expect(install).not.toHaveBeenCalled();
  fixture.dispose();
  expect(fixture.listeners.size).toBe(0);
});
