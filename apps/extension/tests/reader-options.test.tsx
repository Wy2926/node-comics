import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ReactElement} from 'react';
import {ReaderDisplaySettings} from '../src/reader/ReaderOptions';
import {Preferences} from '../src/ui/Preferences';
import {defaults, type Settings} from '../src/types';

const settings: Settings = {...defaults, layout: 'double'};
const noop = () => {};
const display = (allowDouble?: boolean) => <ReaderDisplaySettings settings={settings} setSettings={noop}
  onLayout={noop} sizing={null} allowDouble={allowDouble}/>;

function nodes(value: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children)];
}

describe('reader layout choices', () => {
  it('offers and selects double-page reading only for image readers', () => {
    const html = renderToStaticMarkup(display(true));
    expect(html).toContain('双页阅读');
    expect(html).toMatch(/aria-pressed="true"[^>]*>[^]*?双页阅读<\/button>/);
    const onLayout = vi.fn();
    const choice = ReaderDisplaySettings({settings, setSettings: noop, onLayout, sizing: null, allowDouble: true}).props.children[0];
    expect(choice.props.options.map((option: {id: string}) => option.id)).toEqual(['continuous', 'single', 'double']);
    choice.props.onChange('double');
    expect(onLayout).toHaveBeenCalledWith('double');
  });

  it.each([undefined, false])('keeps EPUB controls single-page when image layout is double and allowDouble is %s', allowDouble => {
    const html = renderToStaticMarkup(display(allowDouble));
    expect(html).not.toContain('双页阅读');
    const choice = ReaderDisplaySettings({settings, setSettings: noop, onLayout: noop, sizing: null, allowDouble}).props.children[0];
    expect(choice.props.options.map((option: {id: string}) => option.id)).toEqual(['continuous', 'single']);
    expect(choice.props.value).toBe('single');
    expect(settings.layout).toBe('double');
  });

  it('uses manga direction on entering double layout from global preferences without resetting later direction choices', () => {
    let current: Settings = {...defaults};
    const tree = Preferences({settings: current, setSettings: next => {current = typeof next === 'function' ? next(current) : next;}});
    const choice = nodes(tree).find(node => node.props['aria-label'] === '阅读方式')!;
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
