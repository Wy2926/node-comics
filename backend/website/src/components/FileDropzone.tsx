import { useEffect, useId, useRef, useState } from 'react';
import type { WorkbenchCopy } from '../i18n/workbench';
import { bindImageImport } from '../lib/image-import-events';
import '../styles/translate.css';
export default function FileDropzone({
  copy: t,
  busyLabel,
  onBusyChange,
  disabled = false,
  compact = false,
  onFiles,
}: {
  copy: Pick<WorkbenchCopy, 'select' | 'drop'>;
  busyLabel: string;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  compact?: boolean;
  onFiles: (files: File[]) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null),
    descriptionId = useId();
  const importing = useRef(false);
  const [busy, setBusy] = useState(false),
    [drag, setDrag] = useState(false);
  async function add(files: File[]) {
    if (importing.current || disabled) return;
    importing.current = true;
    setBusy(true);
    onBusyChange?.(true);
    try {
      await onFiles(files); // Routing and errors belong to the unified workbench.
    } finally {
      importing.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  useEffect(() => bindImageImport(document, files => { setDrag(false); void add(files); }),
    [disabled, onBusyChange, onFiles]);
  return (
    <div
      className="file-dropzone"
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
        {busy ? busyLabel : t.select}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,.pdf,.zip,.cbz,application/pdf,application/zip,application/x-cbz"
        multiple
        hidden
        onChange={(event) => {
          void add(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <div className="file-dropzone-copy">
        <p>{t.drop}</p>
        <small id={descriptionId}>JPG · PNG · WebP · PDF · ZIP · CBZ</small>
      </div>
    </div>
  );
}
