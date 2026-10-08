import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {ReleaseFeatureArtwork} from './ReleaseFeatureArtwork';
import {hasUnseenReleaseNotes, markReleaseNotesSeen, releaseNotes, releaseNotesStorageKey} from './content';
import {useDialogViewport} from '../visual-viewport';
import './release-notes.css';

export function ReleaseNotes({active}: {active: boolean}) {
  const [open, setOpen] = useState(false), [unseen, setUnseen] = useState(hasUnseenReleaseNotes);
  const trigger = useRef<HTMLButtonElement>(null), dialogId = useId();
  useEffect(() => {
    if (active && !open && hasUnseenReleaseNotes() && !document.querySelector('dialog[open]')) setOpen(true);
  }, [active, open]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === releaseNotesStorageKey || event.key === null) setUnseen(hasUnseenReleaseNotes());
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const shown = useCallback(() => { markReleaseNotesSeen(); setUnseen(false); }, []);
  const close = useCallback(() => setOpen(false), []);
  return <>
    <button ref={trigger} className="icon-button nc-release-trigger" aria-label={msg('releaseNotes.trigger', {version: releaseNotes.version})}
      title={msg('releaseNotes.trigger', {version: releaseNotes.version})} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined}
      onClick={() => setOpen(true)}>
      <Icon name="release-notes" size={28}/>{unseen && <i className="nc-release-unseen" aria-hidden="true"/>}
    </button>
    {open && trigger.current && createPortal(<ReleaseNotesDialog id={dialogId} onShown={shown} onClose={close} trigger={trigger.current}/>, trigger.current.closest('.nc-app') ?? document.body)}
  </>;
}

function ReleaseNotesDialog({id, onShown, onClose, trigger}: {id: string; onShown: () => void; onClose: () => void; trigger: HTMLButtonElement | null}) {
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null), titleId = useId(), introId = useId();
  useDialogViewport(dialog);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement;
    element.showModal();
    closeButton.current?.focus({preventScroll: true});
    onShown();
    return () => {
      element.close();
      const target = trigger?.isConnected ? trigger : previous instanceof HTMLElement && previous.isConnected ? previous : null;
      target?.focus({preventScroll: true});
    };
  }, [onShown, trigger]);
  return <dialog ref={dialog} id={id} className="modal nc-release-notes nc-viewport-dialog" aria-labelledby={titleId} aria-describedby={introId}
    onCancel={event => {event.preventDefault(); event.stopPropagation(); onClose();}}>
    <button ref={closeButton} className="icon-button nc-release-close" aria-label={msg('releaseNotes.close')} onClick={onClose}><Icon name="close"/></button>
    <header className="nc-release-cover">
      <div className="nc-release-notes-heading">
        <div className="nc-release-kicker"><Icon name="release-notes" size={18}/><span>{msg('releaseNotes.kicker')}</span></div>
        <h2 id={titleId}>{msg('releaseNotes.title')}</h2>
        <p id={introId}>{msg('releaseNotes.intro', {version: releaseNotes.version})}</p>
      </div>
      <ReleaseVersionStamp/>
    </header>
    <section className="nc-release-content" aria-label={msg('releaseNotes.highlights')} tabIndex={0}>
      <ol className="nc-release-highlights">{releaseNotes.highlights.map((item, index) => <li key={item.title}
        className={'artwork' in item ? `nc-release-featured nc-release-${item.artwork}` : `nc-release-small${'sites' in item ? ' nc-release-source-list' : ''}`}>
        {'artwork' in item ? <>
          <ReleaseFeatureFrame kind={item.artwork}/>
          <ReleaseFeatureBadge kind={item.artwork} number={index + 1} icon={item.icon}/>
          <div className="nc-release-feature-art"><ReleaseFeatureArtwork kind={item.artwork}/></div>
        </> : <div className="nc-release-feature-icon"><Icon name={item.icon} size={24}/></div>}
        <div className="nc-release-feature-text"><h3>{msg(item.title)}</h3>
          {'sites' in item && <ul className="nc-release-sites">{item.sites.map(site => <li key={site}>{site}</li>)}</ul>}
        </div>
      </li>)}</ol>
    </section>
    <footer className="nc-release-footer"><p><Icon name="info" size={16}/>{msg('releaseNotes.hint')}</p>
      <button className="button primary" onClick={onClose}>{msg('releaseNotes.done')}<Icon name="check" size={18}/></button>
    </footer>
  </dialog>;
}

type FeatureKind = 'remote' | 'ocr' | 'prefetch';

function ReleaseFeatureFrame({kind}: {kind: FeatureKind}) {
  const shape = {
    remote: 'M16 6H557L594 34V137L581 152H18L6 139V20Z',
    ocr: 'M20 7H560L593 33V137L574 152H20L7 134V23Z',
    prefetch: 'M24 7H572L594 26V55L584 67L594 79V134L572 152H19L7 134V25Z',
  }[kind];
  return <svg className="nc-release-panel-frame" viewBox="0 0 600 160" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <path d={shape} fill="var(--comic-shadow-color)" transform="translate(3 4)"/>
    <path d={shape} fill="var(--release-panel-paper)" stroke="var(--comic-stroke)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/>
    {kind === 'remote' && <path d="M557 7v27h35" fill="var(--surface)" stroke="var(--comic-stroke)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>}
    {kind === 'ocr' && <path d="M18 46V18h90m474 87v37h-88" fill="none" stroke="var(--release-panel-color)" strokeWidth="4" vectorEffect="non-scaling-stroke"/>}
    {kind === 'prefetch' && <path d="m15 104 11-3m-10 12 18-4m-18 14 26-5" fill="none" stroke="var(--comic-stroke)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" opacity=".45"/>}
  </svg>;
}

function ReleaseFeatureBadge({kind, number, icon}: {kind: FeatureKind; number: number; icon: string}) {
  const shape = {
    remote: 'M8 6h55l8 8-5 8 5 8-8 9H8l-5-8 5-9-5-8Z',
    ocr: 'M10 5h47l14 13v13L58 41H11L3 32V15Z',
    prefetch: 'm10 4 10 5 10-5 10 5 13-5 8 10 11 5-5 10 3 10-15 1-9 6-11-5-13 3-8-8-11-4 5-12-6-7Z',
  }[kind];
  return <div className="nc-release-feature-badge" aria-hidden="true">
    <svg viewBox="0 0 80 48" focusable="false">
      <path d={shape} fill="var(--comic-shadow-color)" transform="translate(2 3)"/>
      <path d={shape} fill="var(--release-panel-color)" stroke="var(--comic-stroke)" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
    <Icon name={icon} size={20}/><b>{String(number).padStart(2, '0')}</b>
  </div>;
}

function ReleaseVersionStamp() {
  return <div className="nc-release-version-stamp">
    <svg viewBox="0 0 160 130" fill="none" aria-hidden="true" focusable="false">
      <path d="m82 6 16 12 22-4 5 19 23 8-9 20 10 20-22 10-5 21-24-3-17 15-15-15-23 3-5-22-22-10 11-20-8-19 23-8 6-19 22 4Z" fill="var(--comic-shadow-color)" transform="translate(3 4)"/>
      <path d="m82 6 16 12 22-4 5 19 23 8-9 20 10 20-22 10-5 21-24-3-17 15-15-15-23 3-5-22-22-10 11-20-8-19 23-8 6-19 22 4Z" fill="var(--icon-comic-yellow)" stroke="var(--comic-stroke)" strokeWidth="2.5" strokeLinejoin="round"/>
      <path d="m40 44 7-5m69 4 8 5M37 82l9 3m70 1 8-4" stroke="var(--comic-stroke)" strokeWidth="2"/>
    </svg>
    <b>v{releaseNotes.version}</b>
  </div>;
}
