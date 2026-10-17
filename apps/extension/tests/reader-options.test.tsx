import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ReactElement} from 'react';
import {ReaderChoice, ReaderDisplaySettings} from '../src/reader/ReaderOptions';
import {ReaderSettings} from '../src/reader/ReaderSettings';
import {Preferences} from '../src/ui/Preferences';
import {defaults, type Settings} from '../src/types';

const settings: Settings = {...defaults, layout: 'double'};
const noop = () => {};
const display = (allowDouble?: boolean) => <ReaderDisplaySettings settings={settings} setSettings={noop}
  layout={settings.layout} direction={settings.direction} onLayout={noop} onDirection={noop} sizing={null} allowDouble={allowDouble}/>;
const displayOptions = {settings, setSettings: noop, layout: settings.layout, direction: settings.direction, onLayout: noop, onDirection: noop, sizing: null};

function nodes(value: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children)];
}

describe('reader layout choices', () => {
  it('offers and selects double-page reading only for image readers', () => {
    const html = renderToStaticMarkup(display(true));
    expect(html).toContain('双页');
    expect(html).toMatch(/aria-pressed="true"[^>]*>[^]*?<span>双页<\/span><\/button>/);
    const onLayout = vi.fn();
    const choice = ReaderDisplaySettings({...displayOptions, onLayout, allowDouble: true}).props.children[0];
    expect(choice.props.options.map((option: {id: string}) => option.id)).toEqual(['default', 'continuous', 'single', 'double']);
    choice.props.onChange('double');
    expect(onLayout).toHaveBeenCalledWith('double');
  });

  it.each([undefined, false])('keeps EPUB controls single-page when image layout is double and allowDouble is %s', allowDouble => {
    const html = renderToStaticMarkup(display(allowDouble));
    expect(html).not.toContain('双页');
    const onLayout = vi.fn();
    const choice = ReaderDisplaySettings({...displayOptions, onLayout, allowDouble}).props.children[0];
    expect(choice.props.options.map((option: {id: string}) => option.id)).toEqual(['default', 'continuous', 'single']);
    expect(choice.props.value).toBe('single');
    expect(settings.layout).toBe('double');
    expect(onLayout).not.toHaveBeenCalled();
  });

  it.each(['continuous', 'single', 'double'] as const)('selects Default for an unset comic override when the global layout is %s', layout => {
    const globalSettings = {...settings, layout};
    const tree = ReaderDisplaySettings({...displayOptions, settings: globalSettings, layout: undefined, allowDouble: true});
    expect(tree.props.children[0].props.value).toBe('default');
    expect(renderToStaticMarkup(tree)).toContain('仅对此漫画生效；选择默认时跟随全局阅读布局。');
    const epub = ReaderDisplaySettings({...displayOptions, settings: globalSettings, layout: undefined});
    expect(epub.props.children[0].props.value).toBe('default');
  });

  it('changes and clears only the comic layout, routes direction separately, and leaves global settings untouched', () => {
    const onLayout = vi.fn(), onDirection = vi.fn(), setSettings = vi.fn();
    const tree = ReaderDisplaySettings({...displayOptions, layout: 'single', direction: 'rtl', onLayout, onDirection, setSettings, allowDouble: true});
    const layout = tree.props.children[0], direction = tree.props.children[2];
    expect(layout.props.value).toBe('single');
    expect(direction.props.value).toBe('rtl');
    layout.props.onChange('double'); layout.props.onChange('default'); direction.props.onChange('ltr');
    expect(onLayout.mock.calls).toEqual([['double'], [undefined]]);
    expect(onDirection).toHaveBeenCalledExactlyOnceWith('ltr');
    expect(setSettings).not.toHaveBeenCalled();
    expect(settings.layout).toBe('double');
    expect(settings.direction).toBe(defaults.direction);
  });

  it('continues to update the global reading background independently of comic layout and direction', () => {
    let current: Settings = {...settings};
    const onLayout = vi.fn(), onDirection = vi.fn();
    const tree = ReaderDisplaySettings({...displayOptions, onLayout, onDirection,
      setSettings: value => {current = typeof value === 'function' ? value(current) : value;}});
    const background = nodes(tree).find(node => node.props.label === '阅读背景')!;
    (background.props.onChange as (value: Settings['readerBackground']) => void)('night');
    expect(current).toEqual({...settings, readerBackground: 'night'});
    expect(onLayout).not.toHaveBeenCalled(); expect(onDirection).not.toHaveBeenCalled();
  });

  it('forwards comic-local values and callbacks through the shared settings shell without replacing global settings', () => {
    const onLayout = vi.fn(), onDirection = vi.fn();
    const tree = ReaderSettings({...displayOptions, layout: undefined, direction: 'rtl', onLayout, onDirection,
      immersive: true, onImmersive: noop, onFullscreen: noop, onShortcuts: noop});
    const display = tree.props.children[0];
    expect(display.props.settings).toBe(settings);
    expect(display.props.layout).toBeUndefined(); expect(display.props.direction).toBe('rtl');
    expect(display.props.onLayout).toBe(onLayout); expect(display.props.onDirection).toBe(onDirection);
  });

  it('shares concise layout labels between reader controls and global preferences', () => {
    const choice = ReaderDisplaySettings({...displayOptions, allowDouble: true}).props.children[0];
    expect(choice.props.options.map((option: {label: string}) => option.label)).toEqual(['默认', '连续', '单页', '双页']);
    expect(choice.props.variant).toBe('cards');
    const preference = nodes(Preferences({settings, setSettings: noop})).find(node => node.props['aria-label'] === '默认阅读布局')!;
    expect(nodes(preference.props.children).map(option => option.props.children)).toEqual(['连续', '单页', '双页']);
    expect(renderToStaticMarkup(display(true))).not.toMatch(/连续阅读|单页阅读|双页阅读/);
  });

  it('uses the same layout selection semantics in icon cards, with complete labels and only one active option', () => {
    const onLayout = vi.fn();
    const displayTree = ReaderDisplaySettings({...displayOptions, layout: 'single', onLayout, allowDouble: true});
    const layout = ReaderChoice(displayTree.props.children[0].props);
    const group = nodes(layout).find(node => node.props.role === 'group')!;
    expect(group.props['aria-label']).toBe('阅读布局');
    expect(group.props.className).toBe('nc-reader-choices nc-reader-choice-cards');
    const buttons = nodes(group).filter(node => node.type === 'button');
    expect(buttons).toHaveLength(4);
    expect(buttons.map(button => button.props['aria-pressed'])).toEqual([false, false, true, false]);
    expect(buttons.map(button => nodes(button).find(node => node.type === 'span')?.props.children)).toEqual(['默认', '连续', '单页', '双页']);
    for (const button of buttons) expect(nodes(button).some(node => typeof node.props.name === 'string')).toBe(true);
    (buttons[0].props.onClick as () => void)();
    (buttons[3].props.onClick as () => void)();
    expect(onLayout.mock.calls).toEqual([[undefined], ['double']]);
    const direction = ReaderChoice(displayTree.props.children[2].props);
    expect(nodes(direction).find(node => node.props.role === 'group')?.props.className).toBe('nc-reader-choices segmented');
  });

  it('uses manga direction on entering double layout from global preferences without resetting later direction choices', () => {
    let current: Settings = {...defaults};
    const tree = Preferences({settings: current, setSettings: next => {current = typeof next === 'function' ? next(current) : next;}});
    const choice = nodes(tree).find(node => node.props['aria-label'] === '默认阅读布局')!;
    expect(choice).toBeDefined();
    const change = (layout: Settings['layout']) => (choice.props.onChange as (event: {target: {value: Settings['layout']}}) => void)({target: {value: layout}});
    change('double');
    expect(current).toEqual({...defaults, layout: 'double', direction: 'rtl'});
    current = {...current, direction: 'ltr'};
    change('double');
    expect(current.direction).toBe('ltr');
    change('single');
    expect(current).toEqual({...defaults, layout: 'single'});
    change('double');
    expect(current.direction).toBe('rtl');
    change('continuous');
    expect(current).toEqual({...defaults, direction: 'rtl'});
  });
});

describe('reader settings action cards', () => {
  const options = {...displayOptions, immersive: true, onImmersive: noop, onFullscreen: noop, onShortcuts: noop};
  const actionGroup = (tree: unknown) => nodes(tree).find(node => node.props.className === 'nc-reader-actions')!;

  it('keeps the four existing actions and their handlers without an open-source link', () => {
    const onFind = vi.fn(), onFullscreen = vi.fn(), onReload = vi.fn(), onShortcuts = vi.fn();
    const group = actionGroup(ReaderSettings({...options, onFullscreen, onReload, onShortcuts,
      extraActions: <button className="button secondary" onClick={onFind}><span>寻找其他语言</span></button>}));
    const buttons = nodes(group).filter(node => node.type === 'button');
    expect(buttons).toHaveLength(4);
    expect(buttons.map(button => nodes(button).find(node => node.type === 'span')?.props.children)).toEqual(['寻找其他语言', '全屏阅读', '重新载入', '键盘快捷键']);
    for (const button of buttons) (button.props.onClick as () => void)();
    for (const callback of [onFind, onFullscreen, onReload, onShortcuts]) expect(callback).toHaveBeenCalledExactlyOnceWith();
    expect(nodes(group).some(node => node.type === 'a')).toBe(false);
    expect(renderToStaticMarkup(group)).not.toContain('打开来源');
  });

  it('keeps reload disabled while busy without disabling other actions', () => {
    const group = actionGroup(ReaderSettings({...options, onReload: vi.fn(), busy: true}));
    const buttons = nodes(group).filter(node => node.type === 'button');
    expect(buttons.map(button => button.props.disabled)).toEqual([undefined, true, undefined]);
    const idleGroup = actionGroup(ReaderSettings({...options, onReload: vi.fn(), busy: false}));
    expect(nodes(idleGroup).filter(node => node.type === 'button').map(button => button.props.disabled)).toEqual([undefined, false, undefined]);
  });

  it('omits unavailable actions instead of rendering placeholder cards', () => {
    const group = actionGroup(ReaderSettings(options));
    const buttons = nodes(group).filter(node => node.type === 'button');
    expect(buttons).toHaveLength(2);
    expect(buttons.map(button => nodes(button).find(node => node.type === 'span')?.props.children)).toEqual(['全屏阅读', '键盘快捷键']);
  });
});
