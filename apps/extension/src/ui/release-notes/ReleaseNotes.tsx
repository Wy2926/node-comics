import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {hasUnseenReleaseNotes, markReleaseNotesSeen, releaseNotes, releaseNotesStorageKey} from './content';
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
  return <dialog ref={dialog} id={id} className="modal nc-release-notes" aria-labelledby={titleId} aria-describedby={introId}
    onCancel={event => {event.preventDefault(); event.stopPropagation(); onClose();}}>
    <button ref={closeButton} className="icon-button nc-release-close" aria-label={msg('releaseNotes.close')} onClick={onClose}><Icon name="close"/></button>
    <header className="nc-release-cover">
      <div className="nc-release-notes-heading">
        <div className="nc-release-kicker"><Icon name="release-notes" size={18}/><span>{msg('releaseNotes.kicker')}</span><b>v{releaseNotes.version}</b></div>
        <h2 id={titleId}>{msg('releaseNotes.title')}</h2>
        <p id={introId}>{msg('releaseNotes.intro', {version: releaseNotes.version})}</p>
      </div>
      <ReleaseArtwork/>
    </header>
    <section className="nc-release-content" aria-label={msg('releaseNotes.highlights')}>
      <ol className="nc-release-highlights">{releaseNotes.highlights.map((item, index) => <li key={item.title}>
        <div className="nc-release-feature-icon"><Icon name={item.icon} size={28}/><span aria-hidden="true">0{index + 1}</span></div>
        <div><h3>{msg(item.title)}</h3><p>{msg(item.body)}</p></div>
      </li>)}</ol>
    </section>
    <footer className="nc-release-footer"><p><Icon name="info" size={16}/>{msg('releaseNotes.hint')}</p>
      <button className="button primary" onClick={onClose}>{msg('releaseNotes.done')}<Icon name="check" size={18}/></button>
    </footer>
  </dialog>;
}

/** A new chapter unfolding: original vector artwork, colored by shared tokens. */
function ReleaseArtwork() {
  return <svg className="nc-release-artwork" viewBox="0 0 240 180" fill="none" stroke="var(--comic-stroke)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <ellipse cx="128" cy="158" rx="88" ry="9" fill="var(--comic-shadow-color)" opacity=".1" stroke="none"/>
    <path d="m26 59 70-15 18 107-70 12Z" fill="var(--icon-comic-mint)"/>
    <path d="m38 48 72-6 10 110-72 6Z" fill="var(--accent-soft)"/>
    <path d="m55 47 61 7 27-5 57 12-10 99-58-11-22 6-65-8Z" fill="var(--comic-shadow-color)" opacity=".12" stroke="none" transform="translate(4 4)"/>
    <path d="m53 43 62 9 26-7 57 12-10 99-57-12-22 7-66-9Z" fill="var(--surface)"/>
    <path d="m115 52-6 99m32-106-10 99"/>
    <path d="m65 59 37 5-3 35-38-5Z" fill="var(--icon-comic-blue)"/>
    <path d="m65 90 11-13 7 8 9-7 7 16" fill="var(--icon-comic-paper)"/>
    <path d="m149 66 35 7-3 29-36-7Z" fill="var(--icon-comic-pink)"/>
    <path d="m159 78 14 3m-15 6 10 2" stroke="var(--icon-comic-paper)" strokeWidth="3"/>
    <path d="m60 109 37 5m-39 5 26 4m60-15 33 7m-35 4 24 5" opacity=".55"/>
    <path d="m104 110 17-9-1 7 21 3-2 11-21-3-1 7Z" fill="var(--icon-comic-mint)"/>
    <path d="m150 15 7 11 13-3-3 13 12 7-12 6 2 14-13-4-8 11-5-13-14 1 6-12-9-10 14-1Z" fill="var(--icon-comic-yellow)"/>
    <path d="m151 31 1 17m-1 7h.1" strokeWidth="3.5"/>
    <path d="m32 23 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="var(--icon-comic-purple)" strokeWidth="1.8"/>
    <path d="m211 91 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" fill="var(--icon-comic-yellow)" strokeWidth="1.8"/>
    <path d="m201 32 7-5m-4 19 11 1M15 110l9 2m-2 10 5-4" stroke="var(--accent)"/>
    <circle cx="62" cy="24" r="3" fill="var(--icon-comic-pink)" stroke="none"/>
    <circle cx="206" cy="137" r="3" fill="var(--icon-comic-mint)" stroke="none"/>
  </svg>;
}
