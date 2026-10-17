import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ReactElement} from 'react';
import type {ReadingView} from '../src/reader/view';
import {defaults, type Settings} from '../src/types';

// Keep the real reader callbacks and persisted view; document rendering is outside these option tests.
const hooks = vi.hoisted(() => ({cursor: 0, states: [] as unknown[], effects: [] as (() => unknown)[], handlers: {} as Record<string, () => unknown>}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: <T,>(initial?: T | (() => T)) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.states[index], (next: T | ((previous: T) => T)) => {hooks.states[index] = typeof next === 'function' ? (next as (previous: T) => T)(hooks.states[index] as T) : next;}];
  },
  useRef: (current: unknown) => ({current}), useMemo: (compute: () => unknown) => compute(),
  useEffect: (effect: () => unknown) => {hooks.effects.push(effect);}, useLayoutEffect: () => {},
}));
vi.mock('../src/shortcuts/react', () => ({useShortcuts: (handlers: typeof hooks.handlers) => {hooks.handlers = handlers;}}));
vi.mock('../src/reader/useReaderControls', () => ({useReaderControls: () => ({
  root: {current: null}, panel: 'settings', immersive: true, hidden: false,
  setPanel: vi.fn(), togglePanel: vi.fn(), closePanel: vi.fn(), setImmersive: vi.fn(), reveal: vi.fn(), toggleControls: vi.fn(), fullscreen: vi.fn(),
})}));
vi.mock('../src/reader/useEpubImages', () => ({useEpubImages: () => ({})}));
vi.mock('../src/comics/application/epub-service', () => ({openEpubEntry: vi.fn()}));

import {EpubReader} from '../src/reader/EpubReader';
import {ReaderSettings} from '../src/reader/ReaderSettings';
import {ReaderChoice, ReaderDisplaySettings, ReaderScale} from '../src/reader/ReaderOptions';
import {installDictionary} from '../src/i18n/runtime';

type Props = Parameters<typeof EpubReader>[0];
type Node = ReactElement<Record<string, unknown>>;
const savedBase = {mode: 'classic', preference: 'translation', zoom: 140, fit: 'width'} as const;
let storage: Map<string, string>;
function fixture(settings: Partial<Settings> = {}, id = 'book-one'): Props {
  return {
    copy: {id, title: id, source: 'epub', sourceKey: id, generation: 1, createdAt: 0, updatedAt: 0, pages: [], pageId: '', relativeOffset: 0, discoveryComplete: true},
    viewKey: `nc-comic-view:${id}`, settings: {...defaults, ...settings}, setSettings: vi.fn(), update: vi.fn(), onBack: vi.fn(),
    backLabel: '书架', backText: '书架', onOpenShortcuts: vi.fn(), notify: vi.fn(), onReadingWindow: vi.fn(),
    translationState: vi.fn(), onRetry: vi.fn(), onLogin: vi.fn(), onUpgrade: vi.fn(),
  };
}
function render(props: Props) {hooks.cursor = 0; hooks.effects = []; return EpubReader(props);}
function flushEffects() {for (const effect of hooks.effects) effect();}
function view() {return hooks.states[0] as ReadingView;}
function saved(props: Props) {return JSON.parse(storage.get(props.viewKey)!);}
function nodes(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Node;
  return [element, ...nodes([ReaderSettings, ReaderDisplaySettings, ReaderChoice, ReaderScale].includes(element.type as never)
    ? (element.type as (props: Record<string, unknown>) => unknown)(element.props) : element.props.children)];
}
function flow(tree: ReactElement) {return nodes(tree).find(node => node.props['data-epub-flow'])!.props['data-epub-flow'];}
function choice(tree: ReactElement, label: string) {return nodes(tree).find(node => node.type === ReaderChoice && node.props.label === label)!;}
function textContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (!value || typeof value !== 'object' || !('props' in value)) return '';
  const element = value as Node;
  return element.props['aria-hidden'] ? '' : textContent(element.props.children);
}
function clickChoice(tree: ReactElement, label: string, text: string) {
  const button = nodes(choice(tree, label)).find(node => node.type === 'button' && textContent(node) === text);
  expect(button).toBeDefined(); (button!.props.onClick as () => void)();
}

beforeEach(() => {
  hooks.cursor = 0; hooks.states = []; hooks.effects = []; hooks.handlers = {};
  storage = new Map();
  vi.stubGlobal('localStorage', {getItem: vi.fn((key: string) => storage.get(key) ?? null), setItem: vi.fn((key: string, value: string) => storage.set(key, value))});
  vi.stubGlobal('document', {addEventListener: vi.fn(), removeEventListener: vi.fn()});
  vi.stubGlobal('window', {addEventListener: vi.fn(), removeEventListener: vi.fn()});
  installDictionary('zh-CN', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('EPUB comic-specific reading options', () => {
  it.each(['continuous', 'single', 'double'] as const)('inherits global %s without pinning it to the comic', layout => {
    const props = fixture({layout}); const tree = render(props);
    expect(flow(tree)).toBe(layout === 'continuous' ? 'scrolled-continuous' : 'paginated');
    expect(choice(tree, '阅读布局').props.value).toBe('default');
    flushEffects(); expect(saved(props)).not.toHaveProperty('layout');
    props.settings = {...props.settings, layout: layout === 'continuous' ? 'single' : 'continuous'};
    expect(flow(render(props))).toBe(layout === 'continuous' ? 'paginated' : 'scrolled-continuous');
    expect(props.setSettings).not.toHaveBeenCalled();
  });

  it.each(['continuous', 'single', 'double'] as const)('restores comic override %s independently of the default', layout => {
    const props = fixture({layout: layout === 'continuous' ? 'single' : 'continuous'});
    storage.set(props.viewKey, JSON.stringify({...savedBase, layout, direction: 'rtl'}));
    const tree = render(props);
    expect(flow(tree)).toBe(layout === 'continuous' ? 'scrolled-continuous' : 'paginated');
    expect(choice(tree, '阅读布局').props.value).toBe(layout === 'double' ? 'single' : layout);
    expect(choice(tree, '阅读方向').props.value).toBe('rtl');
    flushEffects(); expect(saved(props)).toEqual({...savedBase, layout, direction: 'rtl'});
    expect(props.setSettings).not.toHaveBeenCalled();
  });

  it('saves a layout button choice only for this comic and restores it on reopening', () => {
    const props = fixture(); const originalSettings = {...props.settings};
    clickChoice(render(props), '阅读布局', '单页');
    render(props); flushEffects(); expect(saved(props).layout).toBe('single');
    expect(props.settings).toEqual(originalSettings); expect(props.setSettings).not.toHaveBeenCalled();
    hooks.states = []; expect(flow(render(props))).toBe('paginated');
    hooks.states = []; const other = fixture({}, 'book-two');
    expect(flow(render(other))).toBe('scrolled-continuous');
    expect(view()).not.toHaveProperty('layout');
  });

  it('cycles EPUB shortcuts between single and continuous without changing global defaults or saved sizing', () => {
    const props = fixture({layout: 'double'});
    storage.set(props.viewKey, JSON.stringify({...savedBase, direction: 'rtl'}));
    render(props); hooks.handlers['reader.layout']();
    expect(view()).toEqual({...savedBase, direction: 'rtl', layout: 'continuous'});
    render(props); hooks.handlers['reader.layout']();
    expect(view()).toEqual({...savedBase, direction: 'rtl', layout: 'single'});
    render(props); flushEffects(); expect(saved(props)).toEqual(view());
    expect(props.settings.layout).toBe('double'); expect(props.setSettings).not.toHaveBeenCalled();
  });

  it('resets the override to the live global default without discarding direction, font size or translation choice', () => {
    const props = fixture({layout: 'continuous', direction: 'ltr'});
    storage.set(props.viewKey, JSON.stringify({...savedBase, layout: 'single', direction: 'rtl'}));
    clickChoice(render(props), '阅读布局', '默认');
    const tree = render(props); flushEffects();
    expect(flow(tree)).toBe('scrolled-continuous'); expect(choice(tree, '阅读布局').props.value).toBe('default');
    expect(saved(props)).toEqual({...savedBase, direction: 'rtl'});
    props.settings = {...props.settings, layout: 'double'};
    expect(flow(render(props))).toBe('paginated'); expect(view().layout).toBeUndefined();
    expect(props.setSettings).not.toHaveBeenCalled();
  });

  it('keeps comic direction, font-size and translation actions independent of layout and global preferences', () => {
    const props = fixture({layout: 'continuous'});
    storage.set(props.viewKey, JSON.stringify({...savedBase, layout: 'single'}));
    clickChoice(render(props), '阅读方向', '从右向左');
    render(props); hooks.handlers['reader.zoomIn'](); hooks.handlers['reader.original']();
    expect(view()).toEqual({...savedBase, preference: 'original', zoom: 150, layout: 'single', direction: 'rtl'});
    render(props); hooks.handlers['reader.translation']();
    const tree = render(props); flushEffects();
    expect(choice(tree, '阅读方向').props.value).toBe('rtl'); expect(saved(props)).toEqual(view());
    expect(props.settings.direction).toBe('ltr'); expect(props.setSettings).not.toHaveBeenCalled();
  });

  it.each(['corrupt', 'unavailable'] as const)('retains the global fallback when preference storage is %s', failure => {
    const props = fixture({layout: 'single', direction: 'rtl'});
    if (failure === 'corrupt') storage.set(props.viewKey, '{invalid json');
    else vi.mocked(localStorage.getItem).mockImplementation(() => {throw new Error('storage blocked');});
    const tree = render(props);
    expect(flow(tree)).toBe('paginated'); expect(choice(tree, '阅读布局').props.value).toBe('default');
    expect(choice(tree, '阅读方向').props.value).toBe('rtl'); expect(view().preference).toBe('original');
    expect(props.setSettings).not.toHaveBeenCalled();
  });

  it('continues applying local options when saving fails', () => {
    const props = fixture(); vi.mocked(localStorage.setItem).mockImplementation(() => {throw new Error('quota exceeded');});
    clickChoice(render(props), '阅读布局', '单页');
    const tree = render(props); expect(() => flushEffects()).not.toThrow();
    expect(flow(tree)).toBe('paginated'); expect(view().layout).toBe('single');
    expect(props.setSettings).not.toHaveBeenCalled();
  });
});
