import {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';

/** The same utility controls stay inline on desktop and disclose beneath the phone masthead. */
export function HeaderUtilities({page, children}: {page: string; children: ReactNode}) {
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), id = useId();
  useEffect(() => setOpen(false), [page]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('dialog[open]') && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      event.preventDefault(); setOpen(false); trigger.current?.focus({preventScroll: true});
    };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
    return () => {document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape);};
  }, [open]);
  const label = msg('更多操作 · {0}', {'0': msg('主导航')});
  return <div ref={root} className="nc-header-utilities" data-open={open || undefined}>
    <button ref={trigger} className="icon-button nc-header-utilities-trigger" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><Icon name={open ? 'close' : 'more'} size={28}/></button>
    <div id={id} className="nc-header-utilities-content" role="group" aria-label={label}>{children}</div>
  </div>;
}
