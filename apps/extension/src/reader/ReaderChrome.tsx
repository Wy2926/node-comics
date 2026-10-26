import {useEffect,useRef, type CSSProperties, type ReactNode, type Ref} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import type {Settings} from '../types';
import type {ReadingProgressStatus} from '../comics/application/reading-progress';
import {ReadingProgressBadge} from './ReadingProgressBadge';
import {useDialogViewport} from '../ui/visual-viewport';
import './mobile.css';

// Some touch browsers report a fine pointer but no hover (including Android emulators).
export const compactReaderQuery = '(max-width: 700px), (max-width: 1000px) and (max-height: 500px) and (pointer: coarse), (max-width: 1000px) and (max-height: 500px) and (hover: none)';
/** Match the phone.css device gate for the compact reader's initial image fit. */
export function isCompactReaderDevice():boolean{
  return !!window.matchMedia?.(compactReaderQuery).matches&&window.matchMedia('(max-device-width: 1000px) and (pointer: coarse), (max-device-width: 1000px) and (hover: none)').matches;
}

/** A passive position indicator: navigation belongs to the arrows, range and directory. */
export function ReaderPosition({label, value, total, progress}: {label: string; value: number; total: number; progress?: number}) {
  return <span className="nc-reader-position" role="group" aria-label={label} title={label} data-value={value} data-long={String(Math.max(value, total)).length > 3}>
    <span className="nc-reader-position-pages" aria-hidden="true"><strong>{value}</strong><span>/ {total}</span></span>
    {progress !== undefined && <small aria-hidden="true">{progress}%</small>}
  </span>;
}

/** One layout and one set of chrome classes for both image and document renderers. */
export function ReaderShell({ref, background, immersive, hidden, reveal, children}: {
  ref: Ref<HTMLDivElement>;
  background: Settings['readerBackground'];
  immersive: boolean;
  hidden: boolean;
  reveal(): void;
  children: ReactNode;
}) {
  const revealControl = immersive ? (event: {target: EventTarget}) => {
    if ((event.target as Element).closest('.nc-reader-controls')) reveal();
  } : undefined;
  return <div ref={ref} className={`nc-reader${immersive ? ' is-immersive' : ''}${hidden ? ' controls-hidden' : ''}`}
    data-background={background}
    onPointerMove={immersive ? event => {
      // Touch scrolling is not a request to reopen the tools at a screen edge.
      if (event.pointerType !== 'mouse' || !hidden) return;
      if ((event.target as Element).closest('.nc-reader-controls')) {reveal(); return;}
      const bounds = event.currentTarget.getBoundingClientRect();
      const compact = window.matchMedia?.(compactReaderQuery).matches;
      if (compact ? event.clientY - bounds.top < 16 || bounds.bottom - event.clientY < 16
        : event.clientX - bounds.left < 16 || bounds.right - event.clientX < 16) reveal();
    } : undefined}
    onPointerDownCapture={revealControl}
    onPointerUpCapture={revealControl}
    onPointerCancelCapture={revealControl}
    onPointerOver={revealControl}
    onPointerOut={immersive ? event => {
      if (!hidden && !(event.relatedTarget as Element | null)?.closest?.('.nc-reader-controls')) revealControl?.(event);
    } : undefined}
    onFocusCapture={revealControl}
    onBlurCapture={immersive && !hidden ? revealControl : undefined}>
    {children}
  </div>;
}

export function ReaderNavigation({backLabel, backText, title, notice, onBack, progressStatus, directoryOpen, onDirectory, bookmarks, children}: {
  backLabel: string;
  backText: string;
  title: string;
  notice?: string;
  onBack(): void;
  progressStatus?: ReadingProgressStatus;
  directoryOpen: boolean;
  onDirectory(): void;
  children?: ReactNode;
  bookmarks?:ReactNode;
}) {
  return <><nav id="nc-reader-navigation-tools" className="nc-reader-rail left nc-reader-controls" data-scrollbar-mode="overlay" aria-label={msg('阅读导航')}>
    <button data-reader-back-trigger="true" aria-label={backLabel} title={backLabel} onClick={onBack}><Icon name="arrow" style={{transform: 'rotate(180deg)'}}/><span>{backText}</span></button>
    <button data-reader-directory-trigger="true" aria-label={msg('打开目录')} title={notice ? `${title} · ${notice}` : title}
      aria-expanded={directoryOpen} onClick={onDirectory}>
      <Icon name="list"/><span>{msg('目录')}</span>{notice && <i className="nc-rail-notice" aria-hidden="true"/>}
    </button>
    {bookmarks}
    {children && <><span className="nc-rail-divider"/>{children}</>}
  </nav><ReadingProgressBadge status={progressStatus}/></>;
}

export function ReaderTools({label, above, below, children}: {label: string; above: number; below: number; children: ReactNode}) {
  return <nav id="nc-reader-translation-tools" className="nc-reader-rail right nc-reader-controls" data-scrollbar-mode="overlay" aria-label={label}
    style={{'--reader-tools-above': above, '--reader-tools-below': below} as CSSProperties}>{children}</nav>;
}

export function ReaderSettingsButton({open, onClick}: {open: boolean; onClick(): void}) {
  return <button data-reader-settings-trigger="true" aria-label={msg('阅读设置')} title={msg('阅读设置')} aria-expanded={open} onClick={onClick}>
    <Icon name="settings"/><span>{msg('阅读设置')}</span>
  </button>;
}

export function ReaderDrawer({kind, title, label, onClose, children}: {
  kind: 'directory' | 'bookmarks' | 'settings' | 'translation';
  title: string;
  label: string;
  onClose(): void;
  children: ReactNode;
}) {
  const drawer=useRef<HTMLElement>(null);
  useDialogViewport(drawer,kind==='bookmarks');
  useEffect(()=>{
    if(kind!=='bookmarks')return;
    const trap=(event:globalThis.KeyboardEvent)=>{
      const element=drawer.current;
      if(!element||event.defaultPrevented||document.querySelector('dialog[open]'))return;
      if(event.key==='Escape'&&!element.contains(document.activeElement)&&!event.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();onClose();return;}
      if(event.key!=='Tab')return;
      const buttons=[...element.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]')].filter(node=>node.getClientRects().length);
      const target=event.shiftKey?buttons.at(-1):buttons[0];
      if(target&&(!element.contains(document.activeElement)||(event.shiftKey?document.activeElement===buttons[0]:document.activeElement===buttons.at(-1)))){event.preventDefault();target.focus();}
    };
    document.addEventListener('keydown',trap,true);return()=>document.removeEventListener('keydown',trap,true);
  },[kind,onClose]);
  return <>
    <button data-bookmarks={kind==='bookmarks'||undefined} className={`nc-drawer-scrim${kind === 'translation' ? ' nc-translation-scrim' : ''}`} aria-label={msg('关闭阅读面板')} onClick={onClose}/>
    <aside ref={drawer} aria-modal={kind==='bookmarks'||undefined} onKeyDown={event=>{
      if(kind==='bookmarks'&&event.key==='Escape'&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229){event.preventDefault();event.stopPropagation();onClose();}
    }} id={kind === 'translation' ? 'nc-translation-settings' : undefined} role="dialog"
      className={kind === 'translation' ? 'nc-translation-popover nc-reader-controls' : `nc-reader-drawer ${kind === 'directory'||kind === 'bookmarks' ? 'left' : 'right'}`}
      data-bookmarks={kind==='bookmarks'||undefined} aria-label={label}>
      <div className="nc-drawer-title"><h2>{title}</h2><button className="icon-button" aria-label={msg('关闭面板')} onClick={onClose}><Icon name="close"/></button></div>
      {children}
    </aside>
  </>;
}
