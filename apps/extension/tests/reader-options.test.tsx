import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ReactElement} from 'react';
import {ReaderChoice, ReaderDisplaySettings, ReaderScale} from '../src/reader/ReaderOptions';
import {ReaderSettings} from '../src/reader/ReaderSettings';
import {EnhancementToggle} from '../src/ui/EnhancementSettings';
import {Preferences} from '../src/ui/Preferences';
import {bindShortcuts} from '../src/shortcuts/runtime';
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
function choice(tree: unknown, label: string) {
  return nodes(tree).find(node => node.type === ReaderChoice && node.props.label === label) as ReactElement<Parameters<typeof ReaderChoice>[0]>;
}

describe('reader layout choices', () => {
  it('offers and selects double-page reading only for image readers', () => {
    const html = renderToStaticMarkup(display(true));
    expect(html).toContain('双页');
    expect(html).toMatch(/aria-pressed="true"[^>]*>[^]*?<span>双页<\/span><\/button>/);
    const onLayout = vi.fn();
    const layout = choice(ReaderDisplaySettings({...displayOptions, onLayout, allowDouble: true}), '阅读布局');
    expect(layout.props.options.map(option => option.id)).toEqual(['default', 'continuous', 'single', 'double']);
    layout.props.onChange('double');
    expect(onLayout).toHaveBeenCalledWith('double');
  });

  it.each([undefined, false])('keeps EPUB controls single-page when image layout is double and allowDouble is %s', allowDouble => {
    const html = renderToStaticMarkup(display(allowDouble));
    expect(html).not.toContain('双页');
    const onLayout = vi.fn();
    const layout = choice(ReaderDisplaySettings({...displayOptions, onLayout, allowDouble}), '阅读布局');
    expect(layout.props.options.map(option => option.id)).toEqual(['default', 'continuous', 'single']);
    expect(layout.props.value).toBe('single');
    expect(settings.layout).toBe('double');
    expect(onLayout).not.toHaveBeenCalled();
  });

  it.each(['continuous', 'single', 'double'] as const)('selects Default for an unset comic override when the global layout is %s', layout => {
    const globalSettings = {...settings, layout};
    const tree = ReaderDisplaySettings({...displayOptions, settings: globalSettings, layout: undefined, allowDouble: true});
    expect(choice(tree, '阅读布局').props.value).toBe('default');
    expect(renderToStaticMarkup(tree)).toContain('仅对此漫画生效；选择默认时跟随全局阅读布局。');
    const epub = ReaderDisplaySettings({...displayOptions, settings: globalSettings, layout: undefined});
    expect(choice(epub, '阅读布局').props.value).toBe('default');
  });

  it('changes and clears only the comic layout, routes direction separately, and leaves global settings untouched', () => {
    const onLayout = vi.fn(), onDirection = vi.fn(), setSettings = vi.fn();
    const tree = ReaderDisplaySettings({...displayOptions, layout: 'single', direction: 'rtl', onLayout, onDirection, setSettings, allowDouble: true});
    const layout = choice(tree, '阅读布局'), direction = choice(tree, '阅读方向');
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
    const display = nodes(tree).find(node => node.type === ReaderDisplaySettings)!;
    expect(display.props.settings).toBe(settings);
    expect(display.props.layout).toBeUndefined(); expect(display.props.direction).toBe('rtl');
    expect(display.props.onLayout).toBe(onLayout); expect(display.props.onDirection).toBe(onDirection);
  });

  it('shares concise layout labels between reader controls and global preferences', () => {
    const layout = choice(ReaderDisplaySettings({...displayOptions, allowDouble: true}), '阅读布局');
    expect(layout.props.options.map(option => option.label)).toEqual(['默认', '连续', '单页', '双页']);
    expect(layout.props.variant).toBe('cards');
    const preference = nodes(Preferences({settings, setSettings: noop})).find(node => node.props['aria-label'] === '默认阅读布局')!;
    expect(nodes(preference.props.children).map(option => option.props.children)).toEqual(['连续', '单页', '双页']);
    expect(renderToStaticMarkup(display(true))).not.toMatch(/连续阅读|单页阅读|双页阅读/);
  });

  it('uses the same layout selection semantics in icon cards, with complete labels and only one active option', () => {
    const onLayout = vi.fn();
    const displayTree = ReaderDisplaySettings({...displayOptions, layout: 'single', onLayout, allowDouble: true});
    const layout = ReaderChoice(choice(displayTree, '阅读布局').props);
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
    const direction = ReaderChoice(choice(displayTree, '阅读方向').props);
    expect(nodes(direction).find(node => node.props.role === 'group')?.props.className).toBe('nc-reader-choices segmented');
  });

  it.each(['ltr', 'rtl'] as const)('keeps the %s global reading direction while changing default layouts', direction => {
    let current: Settings = {...defaults, direction};
    const tree = Preferences({settings: current, setSettings: next => {current = typeof next === 'function' ? next(current) : next;}});
    const choice = nodes(tree).find(node => node.props['aria-label'] === '默认阅读布局')!;
    expect(choice).toBeDefined();
    const change = (layout: Settings['layout']) => (choice.props.onChange as (event: {target: {value: Settings['layout']}}) => void)({target: {value: layout}});
    change('double');
    expect(current).toEqual({...defaults, layout: 'double', direction});
    change('single');
    expect(current).toEqual({...defaults, layout: 'single', direction});
    change('double');
    expect(current.direction).toBe(direction);
    change('continuous');
    expect(current).toEqual({...defaults, direction});
  });
});

describe('reader settings hierarchy and action cards', () => {
  const options = {...displayOptions, immersive: true, onImmersive: noop, onFullscreen: noop, onShortcuts: noop};
  const more = (tree: unknown) => nodes(tree).find(node => node.type === 'details')!;
  const actionButtons = (tree: unknown) => nodes(tree).filter(node => node.type === 'button' && node.props.className === 'button secondary');
  const label = (button: ReactElement<Record<string, unknown>>) => nodes(button).find(node => node.type === 'span')?.props.children;

  it.each(['缩放', '字号'])('places %s before layout, direction and background controls without changing its handler', label => {
    const onSize = vi.fn();
    const sizing = <ReaderScale label={label} value={100} min={40} max={200} onChange={onSize}/>;
    const tree = ReaderDisplaySettings({...displayOptions, sizing, allowDouble: label === '缩放'});
    const controls = nodes(tree).filter(node => node.type === ReaderScale || node.type === ReaderChoice);
    expect(controls.map(node => node.props.label)).toEqual([label, '阅读布局', '阅读方向', '阅读背景']);
    expect(controls[0]).toBe(sizing);
    (controls[0].props.onChange as (value: number) => void)(110);
    expect(onSize).toHaveBeenCalledExactlyOnceWith(110);
    expect(nodes(tree).some(node => node.type === 'details')).toBe(false);
  });

  it('omits the sizing block when the format has no sizing control', () => {
    const tree = ReaderDisplaySettings({...displayOptions, sizing: null});
    expect(nodes(tree).some(node => node.props.className === 'nc-reader-sizing')).toBe(false);
    expect(choice(tree, '阅读布局')).toBeDefined();
  });

  it('keeps reading controls and fullscreen direct while folding secondary settings into one native disclosure', () => {
    const compare = <button role="switch" aria-label="并排对照" aria-checked={false} onClick={noop}/>;
    const tree = ReaderSettings({...options, children: compare});
    const disclosure = more(tree), secondary = nodes(disclosure);
    expect(disclosure.props.open).toBeUndefined();
    expect(nodes(tree).filter(node => node.type === 'details')).toHaveLength(1);
    expect(secondary.find(node => node.type === 'summary')?.props.children).toBe('更多操作 · 阅读器');
    expect(secondary).toContain(compare);
    expect(secondary.find(node => node.type === EnhancementToggle)?.props.configure).toBe(true);
    expect(secondary.some(node => node.type === ReaderDisplaySettings)).toBe(false);
    expect(secondary.some(node => node.props['aria-label'] === '沉浸阅读')).toBe(false);
    expect(actionButtons(disclosure).map(label)).toEqual(['键盘快捷键']);
    const immersive = nodes(tree).find(node => node.props['aria-label'] === '沉浸阅读');
    expect(immersive?.props['aria-checked']).toBe(true);
    expect(nodes(tree).indexOf(immersive!)).toBeLessThan(nodes(tree).indexOf(disclosure));
    expect(actionButtons(tree).map(label)).toEqual(['全屏阅读', '键盘快捷键']);
  });

  it.each(['Space', 'Enter'])('reserves native %s disclosure activation when Space is assigned to a reader shortcut', code => {
    const summary = nodes(more(ReaderSettings(options))).find(node => node.type === 'summary')!;
    expect(summary.props['data-shortcuts-ignore']).toBe(true);
    const action = vi.fn(), preventDefault = vi.fn(), listeners = new Map<string, (event: KeyboardEvent) => void>();
    const target = {document: {querySelector: () => null},
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type)} as unknown as Window;
    const stop = bindShortcuts(target, {'reader.immersive': action}, {getOverrides: () => ({'reader.immersive': ['Space']})});
    const element = {closest: (selector: string) => selector.includes('[data-shortcuts-ignore]') && summary.props['data-shortcuts-ignore'] ? {} : null};
    listeners.get('keydown')!({code, key: code === 'Space' ? ' ' : 'Enter', composedPath: () => [element], preventDefault} as unknown as KeyboardEvent);
    expect(action).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    stop();
  });

  it('keeps every existing action and handler with fullscreen first and other tools in the secondary group', () => {
    const onFind = vi.fn(), onFullscreen = vi.fn(), onReload = vi.fn(), onShortcuts = vi.fn();
    const tree = ReaderSettings({...options, onFullscreen, onReload, onShortcuts,
      extraActions: <button className="button secondary" onClick={onFind}><span>寻找其他语言</span></button>});
    const buttons = actionButtons(tree);
    expect(buttons).toHaveLength(4);
    expect(buttons.map(label)).toEqual(['全屏阅读', '寻找其他语言', '重新载入', '键盘快捷键']);
    expect(actionButtons(more(tree)).map(label)).toEqual(['寻找其他语言', '重新载入', '键盘快捷键']);
    for (const button of buttons) (button.props.onClick as () => void)();
    for (const callback of [onFind, onFullscreen, onReload, onShortcuts]) expect(callback).toHaveBeenCalledExactlyOnceWith();
    expect(nodes(tree).some(node => node.type === 'a')).toBe(false);
    expect(renderToStaticMarkup(<>{buttons}</>)).not.toContain('打开来源');
  });

  it('keeps reload disabled while busy without disabling other actions', () => {
    const tree = ReaderSettings({...options, onReload: vi.fn(), busy: true});
    const buttons = actionButtons(tree);
    expect(buttons.map(button => button.props.disabled)).toEqual([undefined, true, undefined]);
    const idleTree = ReaderSettings({...options, onReload: vi.fn(), busy: false});
    expect(actionButtons(idleTree).map(button => button.props.disabled)).toEqual([undefined, false, undefined]);
  });

  it('omits unavailable actions instead of rendering placeholder cards', () => {
    const buttons = actionButtons(ReaderSettings(options));
    expect(buttons).toHaveLength(2);
    expect(buttons.map(label)).toEqual(['全屏阅读', '键盘快捷键']);
  });
});
