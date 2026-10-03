import type {ReactNode, Ref} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import type {Settings} from '../types';
import type {ReadingProgressStatus} from '../comics/application/reading-progress';
import {ReadingProgressBadge} from './ReadingProgressBadge';

/** One layout and one set of chrome classes for both image and document renderers. */
export function ReaderShell({ref, background, immersive, hidden, reveal, children}: {
  ref: Ref<HTMLDivElement>;
  background: Settings['readerBackground'];
  immersive: boolean;
  hidden: boolean;
  reveal(): void;
  children: ReactNode;
}) {
  return <div ref={ref} className={`nc-reader ${immersive ? 'is-immersive' : ''} ${hidden ? 'controls-hidden' : ''}`}
    data-background={background}
    onPointerMove={event => {
      const target = event.target as HTMLElement;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (target.closest('.nc-reader-controls') || event.clientX - bounds.left < 8 || bounds.right - event.clientX < 8) reveal();
    }}
    onFocusCapture={event => { if ((event.target as HTMLElement).closest('.nc-reader-controls')) reveal(); }}>
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
  return <><nav className="nc-reader-rail left nc-reader-controls" aria-label={msg('阅读导航')}>
    <button aria-label={backLabel} title={backLabel} onClick={onBack}><Icon name="arrow" style={{transform: 'rotate(180deg)'}}/><span>{backText}</span></button>
    <button data-reader-directory-trigger="true" aria-label={msg('打开目录')} title={notice ? `${title} · ${notice}` : title}
      aria-expanded={directoryOpen} onClick={onDirectory}>
      <Icon name="list"/><span>{msg('目录')}</span>{notice && <i className="nc-rail-notice" aria-hidden="true"/>}
    </button>
    {children && <><span className="nc-rail-divider"/>{children}</>}
  </nav><ReadingProgressBadge status={progressStatus}/></>;
}

export function ReaderTools({label, children}: {label: string; children: ReactNode}) {
  return <nav className="nc-reader-rail right nc-reader-controls" aria-label={label}>{children}</nav>;
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
    {kind !== 'translation' && <button className="nc-drawer-scrim" aria-label={msg('关闭阅读面板')} onClick={onClose}/>}
    <aside id={kind === 'translation' ? 'nc-translation-settings' : undefined} role={kind === 'translation' ? 'dialog' : undefined}
      className={kind === 'translation' ? 'nc-translation-popover nc-reader-controls' : `nc-reader-drawer ${kind === 'directory' ? 'left' : 'right'}`}
      aria-label={label}>
      <div className="nc-drawer-title"><h2>{title}</h2><button className="icon-button" aria-label={msg('关闭面板')} onClick={onClose}><Icon name="close"/></button></div>
      {children}
    </aside>
  </>;
}
