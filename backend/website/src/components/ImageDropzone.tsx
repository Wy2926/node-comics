import { useId, useRef, useState } from 'react';
import { translationCopy, translationError } from '../i18n/translate';
import { localPath, type Locale } from '../i18n';
import { importImages } from '../lib/translation-store';
import '../styles/translate.css';
export default function ImageDropzone({
  locale,
  onAdded,
  disabled = false,
  compact = false,
}: {
  locale: Locale;
  onAdded?: () => Promise<void>;
  disabled?: boolean;
  compact?: boolean;
}) {
  const t = translationCopy[locale],
    input = useRef<HTMLInputElement>(null),
    descriptionId = useId();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [drag, setDrag] = useState(false);
  async function add(files: File[]) {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      await importImages(files);
      if (onAdded) await onAdded();
      else location.assign(localPath('/translate/', locale));
    } catch (error) {
      setError(
        translationError(error instanceof Error ? error.message : '', t),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="image-dropzone"
      data-drag={drag}
      data-compact={compact}
      aria-busy={busy}
      aria-label={t.select}
      aria-describedby={descriptionId}
      role="group"
      tabIndex={0}
      onDragOver={(event) => {
        event.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDrag(false);
        void add(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length) {
          event.preventDefault();
          void add(files);
        }
      }}
    >
      <div className="upload-mark" aria-hidden="true">
        <svg viewBox="0 0 64 64" fill="none">
          <path d="M15 12 9 47l34 6 6-35" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
          <rect x="19" y="9" width="36" height="43" rx="3" fill="var(--surface)" stroke="currentColor" strokeWidth="2.5" />
          <path d="M25 33h11v13H25zM40 39h9v7h-9z" stroke="currentColor" strokeWidth="2" />
          <path d="M28 17h16v9H34l-5 4v-4h-1z" fill="var(--accent-soft)" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M55 2v12m-6-6h12" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </div>
      <button
        type="button"
        className="button"
        disabled={busy || disabled}
        onClick={() => input.current?.click()}
      >
        {busy ? t.busy : compact ? t.newImages : t.select}
        <span aria-hidden="true">↗</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(event) => {
          void add(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <p>{t.drop}</p>
      <small id={descriptionId}>{t.formats}</small>
      {error && (
        <p role="alert" className="translation-error">
          {error}
        </p>
      )}
    </div>
  );
}
