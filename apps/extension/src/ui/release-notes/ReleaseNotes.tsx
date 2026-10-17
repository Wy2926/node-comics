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
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null), titleId = useId();
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
  return <dialog ref={dialog} id={id} className="modal nc-release-notes nc-viewport-dialog" aria-labelledby={titleId}
    onCancel={event => {event.preventDefault(); event.stopPropagation(); onClose();}}>
    <button ref={closeButton} className="icon-button nc-release-close" aria-label={msg('releaseNotes.close')} onClick={onClose}><Icon name="close"/></button>
    <header className="nc-release-cover">
      <div className="nc-release-notes-heading">
        <div className="nc-release-kicker"><Icon name="release-notes" size={18}/><span>{msg('releaseNotes.kicker')}</span></div>
        <div className="nc-release-version">{releaseNotes.version}</div>
        <h2 id={titleId}>{msg('releaseNotes.title')}</h2>
      </div>
      <div className="nc-release-cover-art"><ReleaseFeatureArtwork/></div>
    </header>
    <section className="nc-release-content" aria-label={msg('releaseNotes.highlights')} tabIndex={0}>
      <ul className="nc-release-highlights">{releaseNotes.highlights.map(item => <li key={item.title}>
        <div className="nc-release-feature-icon"><Icon name={item.icon} size={28}/></div>
        <div className="nc-release-feature-text"><h3>{msg(item.title)}</h3>
          <p>{msg(item.description)}</p>
        </div>
      </li>)}</ul>
    </section>
    <footer className="nc-release-footer">
      <button className="button primary" onClick={onClose}>{msg('releaseNotes.done')}<Icon name="check" size={18}/></button>
    </footer>
  </dialog>;
}
