import {useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import type {Settings} from '../types';
import type {ReadingProgressStatus} from '../comics/application/reading-progress';
import {ReadingProgressBadge} from './ReadingProgressBadge';
import './mobile.css';

// Some touch browsers report a fine pointer but no hover (including Android emulators).
export const compactReaderQuery = '(max-width: 700px), (max-width: 1000px) and (max-height: 500px) and (pointer: coarse), (max-width: 1000px) and (max-height: 500px) and (hover: none)';

/** Done releases the phone keyboard; numeric inputs commit through the resulting blur. */
export function dismissReaderKeyboard(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  event.currentTarget.blur();
}

/** Keep unfinished edits local instead of navigating on an empty or partial number. */
export function ReaderNumberInput({label, value, max, disabled, onCommit}: {
  label: string;
  value: number;
  max: number;
  disabled?: boolean;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <input aria-label={label} type="number" inputMode="numeric" enterKeyHint="done"
    min={1} max={max} value={draft ?? value} disabled={disabled}
    onChange={event => setDraft(event.currentTarget.value)}
    onKeyDown={dismissReaderKeyboard}
    onBlur={event => {
      const raw = event.currentTarget.value;
      setDraft(null);
      if (!raw.trim() || !Number.isInteger(Number(raw))) return;
      const next = Math.max(1, Math.min(max, Number(raw)));
      if (next !== value) onCommit(next);
    }}/>
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
  return <div ref={ref} className={`nc-reader ${hidden ? 'controls-hidden' : ''}`}
    data-background={background}
    onPointerMove={immersive ? event => {
      // Touch scrolling is not a request to reopen the tools at a screen edge.
      if (event.pointerType === 'touch') return;
      if ((event.target as Element).closest('.nc-reader-controls')) {reveal(); return;}
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX - bounds.left < 8 || bounds.right - event.clientX < 8) reveal();
    } : undefined}
    onPointerDownCapture={revealControl}
    onFocusCapture={revealControl}
    onBlurCapture={revealControl}>
    {children}
    {hidden && <button className="nc-reveal" aria-label={msg('显示阅读工具')} onClick={reveal}><Icon name="settings" size={20}/></button>}
  </div>;
}

export function ReaderNavigation({backLabel, backText, title, notice, onBack, progressStatus, directoryOpen, onDirectory, children}: {
  backLabel: string;
  backText: string;
  title: string;
  notice?: string;
  onBack(): void;
  progressStatus?: ReadingProgressStatus;
  directoryOpen: boolean;
  onDirectory(): void;
  children?: ReactNode;
}) {
  return <><nav id="nc-reader-navigation-tools" className="nc-reader-rail left nc-reader-controls" data-scrollbar-mode="overlay" aria-label={msg('阅读导航')}>
    <button data-reader-back-trigger="true" aria-label={backLabel} title={backLabel} onClick={onBack}><Icon name="arrow" style={{transform: 'rotate(180deg)'}}/><span>{backText}</span></button>
    <button data-reader-directory-trigger="true" aria-label={msg('打开目录')} title={notice ? `${title} · ${notice}` : title}
      aria-expanded={directoryOpen} onClick={onDirectory}>
      <Icon name="list"/><span>{msg('目录')}</span>{notice && <i className="nc-rail-notice" aria-hidden="true"/>}
    </button>
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
  kind: 'directory' | 'settings' | 'translation';
  title: string;
  label: string;
  onClose(): void;
  children: ReactNode;
}) {
  return <>
    <button className={`nc-drawer-scrim${kind === 'translation' ? ' nc-translation-scrim' : ''}`} aria-label={msg('关闭阅读面板')} onClick={onClose}/>
    <aside id={kind === 'translation' ? 'nc-translation-settings' : undefined} role="dialog"
      className={kind === 'translation' ? 'nc-translation-popover nc-reader-controls' : `nc-reader-drawer ${kind === 'directory' ? 'left' : 'right'}`}
      aria-label={label}>
      <div className="nc-drawer-title"><h2>{title}</h2><button className="icon-button" aria-label={msg('关闭面板')} onClick={onClose}><Icon name="close"/></button></div>
      {children}
    </aside>
  </>;
}
