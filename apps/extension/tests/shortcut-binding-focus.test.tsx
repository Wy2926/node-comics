import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {KeyboardEvent} from 'react';
import {ShortcutBindingControl} from '../src/ui/shortcuts/ShortcutBindingControl';

const hooks = vi.hoisted(() => ({cursor: 0, refs: [] as Array<{current: unknown}>, effects: [] as Array<() => void>}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useRef: (current: unknown) => hooks.refs[hooks.cursor++] ?? (hooks.refs[hooks.cursor - 1] = {current}),
  useLayoutEffect: (effect: () => void) => {hooks.effects.push(effect);},
}));

type Props = Parameters<typeof ShortcutBindingControl>[0];
let editor: HTMLButtonElement, body: HTMLElement;
function render(change: Partial<Props> = {}) {
  hooks.cursor = 0; hooks.effects = [];
  const control = ShortcutBindingControl({label: '查看原图', binding: 'KeyO', recording: true, disabled: false,
    onStart: vi.fn(), onStop: vi.fn(), onRecord: vi.fn(), onRemove: vi.fn(), ...change});
  const key = control.props.children[0];
  key.props.ref.current = editor;
  for (const effect of hooks.effects) effect();
  return key;
}
beforeEach(() => {
  hooks.refs = []; hooks.effects = []; hooks.cursor = 0;
  body = {} as HTMLElement;
  editor = {focus: vi.fn(() => {Object.assign(document, {activeElement: editor});})} as unknown as HTMLButtonElement;
  vi.stubGlobal('document', {body, activeElement: editor});
});
afterEach(() => vi.unstubAllGlobals());

describe('shortcut editing focus after a save', () => {
  it.each(['success', 'failure'] as const)('restores the focused editor once after %s releases the save lock', result => {
    const key = render({onRecord: () => true});
    key.props.onKeyDown({currentTarget: editor} as KeyboardEvent<HTMLButtonElement>);
    Object.assign(document, {activeElement: body});
    render({disabled: true}); expect(editor.focus).not.toHaveBeenCalled();
    render({recording: false, binding: result === 'success' ? 'Ctrl+Alt+KeyU' : 'KeyO'});
    expect(editor.focus).toHaveBeenCalledExactlyOnceWith({preventScroll: true});
    Object.assign(document, {activeElement: body});
    render({disabled: true}); render({disabled: false});
    expect(editor.focus).toHaveBeenCalledOnce();
  });

  it.each([undefined, false])('does not remember a cancelled, invalid or non-recording key returning %s', accepted => {
    const key = render({onRecord: () => accepted});
    key.props.onKeyDown({currentTarget: editor} as KeyboardEvent<HTMLButtonElement>);
    Object.assign(document, {activeElement: body});
    render({disabled: true}); render({disabled: false});
    expect(editor.focus).not.toHaveBeenCalled();
  });

  it('does not take focus back from another action while the save finishes', () => {
    const key = render({onRecord: () => true});
    key.props.onKeyDown({currentTarget: editor} as KeyboardEvent<HTMLButtonElement>);
    render({disabled: true}); Object.assign(document, {activeElement: {}});
    render({disabled: false}); expect(editor.focus).not.toHaveBeenCalled();
    Object.assign(document, {activeElement: body}); render({binding: 'KeyT'});
    expect(editor.focus).not.toHaveBeenCalled();
  });
});
