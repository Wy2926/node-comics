import { useEffect, useId, useRef, useState } from 'react';
import { translationError } from '../i18n/translation-error';
import type { TranslationCopy } from '../i18n/translate';
import { localPath, type Locale } from '../i18n/locales';
import { importImages } from '../lib/translation-store';
import { bindImageImport } from '../lib/image-import-events';
import '../styles/translate.css';
export default function ImageDropzone({
  locale,
  copy: t,
  onAdded,
  onBusyChange,
  disabled = false,
  compact = false,
}: {
  locale: Locale;
  copy: TranslationCopy;
  onAdded?: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null),
    descriptionId = useId();
  const importing = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [drag, setDrag] = useState(false);
  async function add(files: File[]) {
    if (importing.current || disabled) return;
    importing.current = true;
    setBusy(true);
    onBusyChange?.(true);
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
      importing.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  useEffect(() => bindImageImport(document, files => { setDrag(false); void add(files); }),
    [disabled, locale, onAdded, onBusyChange]);
  return (
    <div
      className="image-dropzone"
      data-drag={drag}
      data-compact={compact}
      aria-busy={busy}
      aria-disabled={busy || disabled}
      aria-label={t.select}
      aria-describedby={descriptionId}
      role="group"
      tabIndex={busy || disabled ? -1 : 0}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (event.key === 'Enter' || event.key === ' ') &&
          !busy && !disabled
        ) {
          event.preventDefault();
          input.current?.click();
        }
      }}
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
    >
      <div className="upload-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
        </svg>
      </div>
      <button
        type="button"
        className="button"
        disabled={busy || disabled}
        onClick={() => input.current?.click()}
      >
        {busy ? t.busy : compact ? t.newImages : t.select}
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
      <div className="image-dropzone-copy">
        <p>{t.drop}</p>
        <small id={descriptionId}>{t.formats}</small>
      </div>
      {error && (
        <p role="alert" className="translation-error">
          {error}
        </p>
      )}
    </div>
  );
}
