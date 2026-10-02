import {useLayoutEffect, useRef, type KeyboardEvent} from 'react';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {formatBinding} from '../../shortcuts/keys';

type Props = {
  label: string;
  binding?: string;
  compact?: boolean;
  recording: boolean;
  disabled: boolean;
  describedBy?: string;
  invalid?: boolean;
  onStart: () => void;
  onStop: () => void;
  onRecord: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onRemove: () => void;
};

/** A key recorder, not a text input: keep Tab traversal and a separate remove action. */
export function ShortcutBindingControl({label, binding, compact, recording, disabled, describedBy, invalid, onStart, onStop, onRecord, onRemove}: Props) {
  const editor = useRef<HTMLButtonElement>(null), removedFocus = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (disabled || !removedFocus.current) return;
    const previous = removedFocus.current;
    removedFocus.current = null;
    // Removing a binding replaces its clear button with an add slot. Keep
    // keyboard editing in that slot, without stealing focus from another action.
    if (document.activeElement === previous || document.activeElement === document.body) editor.current?.focus({preventScroll: true});
  }, [binding, disabled]);
  const actionLabel = binding ? msg('修改“{0}”的快捷键', {'0': label}) : msg('添加“{0}”的快捷键', {'0': label});
  const formattedBinding = binding ? formatBinding(binding) : undefined;
  const removeLabel = binding ? msg('移除“{0}”的快捷键', {'0': `${label} · ${formattedBinding}`}) : undefined;
  return <div className={'nc-shortcut-binding' + (recording ? ' is-recording' : !binding ? ' is-empty' : '') + (compact && !recording ? ' is-compact' : '') + (disabled ? ' is-disabled' : '')}>
    <button ref={editor} type="button" className="nc-shortcut-key" disabled={disabled}
      aria-label={actionLabel} title={binding ? `${actionLabel} · ${formattedBinding}` : actionLabel}
      aria-description={formattedBinding} aria-describedby={describedBy} aria-invalid={invalid || undefined}
      onClick={onStart} onBlur={() => {if (recording) onStop();}} onKeyDown={onRecord}>
      {recording ? <><Icon name="keyboard" size={16}/><span>{msg('按下组合键')}</span></> : binding ? <span className="nc-shortcut-keycaps">
        {binding.split('+').map((key, index) => <span className="nc-shortcut-key-part" key={key}>
          {index > 0 && <span className="nc-shortcut-plus" aria-hidden="true"> + </span>}<kbd>{formatBinding(key)}</kbd>
        </span>)}
      </span> : <><Icon name="plus" size={18}/>{!compact && <span>{msg('添加快捷键')}</span>}</>}
    </button>
    {binding && <button type="button" className="nc-shortcut-remove" disabled={disabled}
      aria-label={removeLabel} title={removeLabel} onClick={event => {
        removedFocus.current = document.activeElement === event.currentTarget ? event.currentTarget : null;
        onRemove();
      }}><Icon name="close" size={16}/></button>}
  </div>;
}
