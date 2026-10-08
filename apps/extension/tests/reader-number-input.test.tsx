import {readFileSync} from 'node:fs';
import type {ChangeEvent, FocusEvent, KeyboardEvent} from 'react';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({draft: null as string | null}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: () => [state.draft, (draft: string | null) => {state.draft = draft;}],
}));
import {compactReaderQuery, ReaderNumberInput} from '../src/reader/ReaderChrome';

const onCommit = vi.fn();
const render = (value = 3, max = 20) => ReaderNumberInput({label: 'Page', value, max, onCommit}).props;
const change = (value: string) => render().onChange!({currentTarget: {value}} as ChangeEvent<HTMLInputElement>);
const blur = (value: string) => render().onBlur!({currentTarget: {value}} as FocusEvent<HTMLInputElement>);
beforeEach(() => {state.draft = null; onCommit.mockClear();});

describe('shared reader numeric draft', () => {
  it('allows clearing and replacing a page without navigating before blur', () => {
    change(''); expect(render().value).toBe('');
    change('2'); expect(render().value).toBe('2');
    expect(onCommit).not.toHaveBeenCalled();
    blur('2');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(2);
    expect(state.draft).toBeNull();
  });

  it('keeps a multi-digit chapter local until it is complete', () => {
    change('1'); change('12');
    expect(render().value).toBe('12');
    expect(onCommit).not.toHaveBeenCalled();
    blur('12');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(12);
  });

  it.each(['', ' ', 'abc', 'NaN', 'Infinity', '2.5', '3'])('restores the current page instead of jumping for %j', raw => {
    change(raw); blur(raw);
    expect(onCommit).not.toHaveBeenCalled();
    expect(render().value).toBe(3);
  });

  it.each([['0', 1], ['-3', 1], ['21', 20], ['999', 20], ['02', 2]] as const)('bounds the integer %s to %i', (raw, expected) => {
    change(raw); blur(raw);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it('reflects navigation outside an edit without overwriting an unfinished draft', () => {
    expect(render(4).value).toBe(4);
    change('12');
    expect(render(4).value).toBe('12');
    blur('');
    expect(render(4).value).toBe(4);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits once through the Done key blur and retains native numeric keyboard hints', () => {
    change('12');
    const input = render(), preventDefault = vi.fn();
    const releaseFocus = vi.fn(() => blur('12'));
    input.onKeyDown!({key: 'Enter', nativeEvent: {isComposing: false, keyCode: 13},
      currentTarget: {blur: releaseFocus}, preventDefault} as unknown as KeyboardEvent<HTMLInputElement>);
    expect(releaseFocus).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(12);
    expect(input).toMatchObject({type: 'number', inputMode: 'numeric', enterKeyHint: 'done', min: 1, max: 20});
    expect(ReaderNumberInput({label: 'Chapter', value: 1, max: 0, disabled: true, onCommit}).props.disabled).toBe(true);
  });
});

it('keeps compact reader CSS and directory behavior aligned for short no-hover screens', () => {
  const css = readFileSync(new URL('../src/reader/mobile.css', import.meta.url), 'utf8');
  const media = [...css.matchAll(/@media\s*([^{]+)\{/g)].map(match => match[1].trim());
  expect(media[0]).toBe(compactReaderQuery);
  expect(compactReaderQuery.split(', ')).toEqual([
    '(max-width: 700px)',
    '(max-width: 1000px) and (max-height: 500px) and (pointer: coarse)',
    '(max-width: 1000px) and (max-height: 500px) and (hover: none)',
  ]);
  expect(media.at(-1)).toBe(compactReaderQuery.split(', ').slice(1)
    .map(query => query.replace(' and (pointer:', ' and (orientation: landscape) and (pointer:')
      .replace(' and (hover:', ' and (orientation: landscape) and (hover:')).join(', '));
  const touch = readFileSync(new URL('../src/ui/touch-controls.css', import.meta.url), 'utf8');
  expect(touch).toContain('@media (max-width: 700px), (pointer: coarse), (hover: none)');
});
