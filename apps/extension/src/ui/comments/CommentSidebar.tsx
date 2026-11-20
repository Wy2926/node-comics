import {useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {hasShortcutOverlay} from '../../shortcuts/runtime';
import {useDialogViewport} from '../visual-viewport';
import './comments.css';

export function CommentSidebar({subject, onClose, children}: {subject: string; onClose: () => void; children: ReactNode}) {
  const panel = useRef<HTMLElement>(null), close = useRef(onClose);
  const [expanded, setExpanded] = useState(false);
  const sizeLabel = expanded ? msg('恢复紧凑面板') : msg('展开评论面板');
  close.current = onClose;
  useDialogViewport(panel);
  useLayoutEffect(() => {
    const element = panel.current!, opener = document.activeElement;
    if (!(opener instanceof HTMLElement) || opener.matches(':focus-visible,body')) element.querySelector('button')?.focus({preventScroll: true});
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || hasShortcutOverlay(document)) return;
      event.preventDefault(); event.stopPropagation(); close.current();
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      if (element.contains(document.activeElement) && opener instanceof HTMLElement && opener.isConnected) opener.focus({preventScroll: true});
    };
  }, []);
  return <aside id="nc-comments-panel" ref={panel} className="nc-comments-panel" aria-label={msg('评论')} data-expanded={expanded || undefined} data-shortcuts-ignore>
    <header className="nc-comments-heading">
      <span className="nc-comments-mark"><Icon name="message" size={20}/></span>
      <div><h2>{msg('评论')}</h2><p title={subject}>{subject}</p></div>
      <button type="button" className="icon-button" aria-label={sizeLabel} title={sizeLabel} aria-expanded={expanded} aria-controls="nc-comments-panel"
        onClick={() => setExpanded(value => !value)}><Icon name={expanded ? 'minus' : 'expand'} size={16}/></button>
      <button type="button" className="icon-button" aria-label={msg('关闭面板')} onClick={onClose}><Icon name="close" size={18}/></button>
    </header>
    {children}
  </aside>;
}
