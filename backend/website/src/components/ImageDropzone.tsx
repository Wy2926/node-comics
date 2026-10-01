import { useRef, useState } from 'react';
import { translationCopy, translationError } from '../i18n/translate';
import { localPath, type Locale } from '../i18n';
import { importImages } from '../lib/translation-store';
import '../styles/translate.css';
export default function ImageDropzone({
  locale,
  onAdded,
  disabled = false,
}: {
  locale: Locale;
  onAdded?: () => Promise<void>;
  disabled?: boolean;
}) {
  const t = translationCopy[locale],
    input = useRef<HTMLInputElement>(null);
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
        ＋
      </div>
      <button
        type="button"
        className="button"
        disabled={busy || disabled}
        onClick={() => input.current?.click()}
      >
        {busy ? t.busy : t.select}
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
      <small>{t.formats}</small>
      {error && (
        <p role="alert" className="translation-error">
          {error}
        </p>
      )}
    </div>
  );
}
