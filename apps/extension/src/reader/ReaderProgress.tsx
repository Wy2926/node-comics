import {useEffect, useRef, useState} from 'react';
import {msg} from '../i18n/runtime';

const rangeKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** Scrubbing owns only a local preview; the reader receives one completed destination. */
export function ReaderProgress({value, min, max, disabled, valueText, percentage = false, onCommit}: {
  value: number; min: number; max: number; disabled?: boolean;
  valueText(value: number): string; percentage?: boolean; onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState<number>();
  const pending = useRef<number | undefined>(undefined);
  const gesture = useRef<{kind: 'pointer' | 'keyboard'; pointerId?: number; canceled?: boolean} | undefined>(undefined);
  function clearPreview() {pending.current = undefined; setDraft(undefined);}
  function cancel() {if (gesture.current) gesture.current.canceled = true; clearPreview();}
  function finish() {
    const next = pending.current, canceled = gesture.current?.canceled;
    gesture.current = undefined; clearPreview();
    if (!disabled && !canceled && next !== undefined && next !== value) onCommit(next);
  }
  const complete = useRef(finish); complete.current = finish;
  // External navigation or a changed chapter invalidates an unfinished destination.
  useEffect(cancel, [value, min, max, disabled]);
  useEffect(() => {
    const hidden = () => {if (document.hidden) cancel();};
    const released = (event: PointerEvent) => {if (gesture.current?.pointerId === event.pointerId) complete.current();};
    window.addEventListener('blur', cancel);
    window.addEventListener('pointerup', released);
    document.addEventListener('visibilitychange', hidden);
    return () => {window.removeEventListener('blur', cancel); window.removeEventListener('pointerup', released); document.removeEventListener('visibilitychange', hidden);};
  }, []);
  return <span className="nc-reader-progress-control">
    <input className="nc-reader-progress" type="range" aria-label={msg('阅读进度')}
      aria-valuetext={valueText(draft ?? value)} min={min} max={max} step={1} value={draft ?? value} disabled={disabled}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || !event.isPrimary) return;
        gesture.current = {kind: 'pointer', pointerId: event.pointerId}; clearPreview();
        // Native range thumbs own capture; overriding it prevents dragging in Chrome.
      }}
      onChange={event => {
        if (disabled || gesture.current?.canceled) return;
        const next = Number(event.currentTarget.value);
        if (!gesture.current) {if (next !== value) onCommit(next); return;}
        pending.current = next; setDraft(next);
      }}
      onPointerUp={event => {if (gesture.current?.pointerId === event.pointerId) finish();}}
      onPointerCancel={cancel} onBlur={cancel}
      onKeyDown={event => {
        if (event.key === 'Escape' && gesture.current) {event.preventDefault(); event.stopPropagation(); cancel();}
        else if (rangeKeys.has(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
          if (gesture.current?.kind !== 'keyboard' || gesture.current.canceled) gesture.current = {kind: 'keyboard'};
        }
      }}
      onKeyUp={event => {if (rangeKeys.has(event.key) && gesture.current?.kind === 'keyboard') finish();}}/>
    {draft !== undefined && <output className="nc-reader-progress-preview" aria-hidden="true">{draft}{percentage ? '%' : ''}</output>}
  </span>;
}
