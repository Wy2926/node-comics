import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {createPortal} from 'react-dom';
import {msg} from '../i18n/runtime';

const rangeKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const lensWidth = 152, lensHeight = 132;
type PreviewAnchor = {root: Element; bounds: DOMRect; width: number; height: number};

/** Measure once when a gesture starts; subsequent values only move the lens. */
export function progressPreviewPosition({bounds, width, height}: Omit<PreviewAnchor, 'root'>, value: number, min: number, max: number) {
  const vertical = bounds.height > bounds.width;
  const ratio = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const thumb = (vertical ? bounds.top : bounds.left) + 12 + ratio * Math.max(0, (vertical ? bounds.height : bounds.width) - 24);
  const clamp = (value: number, extent: number, size: number) => Math.max(12, Math.min(value, extent - size - 12));
  const left = clamp(vertical ? bounds.right + 24 : thumb - lensWidth / 2, width, lensWidth);
  const top = clamp(vertical ? thumb - lensHeight / 2 : bounds.bottom + 24, height, lensHeight);
  return {vertical, left, top, offset: Math.max(16, Math.min(thumb - (vertical ? top : left), (vertical ? lensHeight : lensWidth) - 16))};
}

/** Scrubbing owns only a local preview; the reader receives one completed destination. */
export function ReaderProgress({value, min, max, disabled, valueText, percentage = false, onCommit}: {
  value: number; min: number; max: number; disabled?: boolean;
  valueText(value: number): string; percentage?: boolean; onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState<number>();
  const previewAnchor = useRef<PreviewAnchor | undefined>(undefined);
  const pending = useRef<number | undefined>(undefined);
  const gesture = useRef<{kind: 'pointer' | 'keyboard'; pointerId?: number; canceled?: boolean} | undefined>(undefined);
  function clearPreview() {pending.current = undefined; setDraft(undefined); previewAnchor.current = undefined;}
  function preview(input: HTMLInputElement) {
    clearPreview();
    const root = input.closest('.nc-reader');
    if (root) previewAnchor.current = {root, bounds: input.getBoundingClientRect(), width: window.innerWidth, height: window.innerHeight};
  }
  function cancel() {
    if (!gesture.current || gesture.current.canceled) return;
    gesture.current.canceled = true; clearPreview();
  }
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
    window.addEventListener('resize', cancel);
    window.addEventListener('scroll', cancel, true);
    window.addEventListener('pointerup', released);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); window.removeEventListener('scroll', cancel, true);
      window.removeEventListener('pointerup', released); document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  const anchor = previewAnchor.current;
  const position = anchor && draft !== undefined ? progressPreviewPosition(anchor, draft, min, max) : undefined;
  return <span className="nc-reader-progress-control">
    <input className="nc-reader-progress" type="range" aria-label={msg('阅读进度')}
      aria-valuetext={valueText(draft ?? value)} min={min} max={max} step={1} value={draft ?? value} disabled={disabled}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || !event.isPrimary) return;
        gesture.current = {kind: 'pointer', pointerId: event.pointerId}; preview(event.currentTarget);
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
        else if (!disabled && rangeKeys.has(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
          if (gesture.current?.kind !== 'keyboard' || gesture.current.canceled) {
            gesture.current = {kind: 'keyboard'}; preview(event.currentTarget);
          }
        }
      }}
      onKeyUp={event => {if (rangeKeys.has(event.key) && gesture.current?.kind === 'keyboard') finish();}}/>
    {anchor && position && createPortal(<output className="nc-reader-progress-preview" aria-hidden="true"
      data-axis={position.vertical ? 'vertical' : 'horizontal'} data-long={String(draft).length > 3}
      style={{left: position.left, top: position.top, width: lensWidth, height: lensHeight, '--thumb-offset': `${position.offset}px`} as CSSProperties}>
      <span>{msg('阅读进度')}</span><strong>{draft}{percentage && <small>%</small>}</strong>
      {!percentage && <span>/ {max}</span>}
    </output>, anchor.root)}
  </span>;
}
