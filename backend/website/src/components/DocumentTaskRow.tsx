import { documentCopy, documentError, documentFormat as format } from '../i18n/documents';
import { localPath, type Locale } from '../i18n/locales';
import type { DocumentTask } from '../lib/document-api';

export default function DocumentTaskRow({ row, locale, disabled, onAction, uploadProgress }: {
  row: DocumentTask; locale: Locale; disabled: boolean;
  onAction: (row: DocumentTask, operation: 'cancel' | 'resume' | 'download') => void;
  uploadProgress?: { phase: 'hashing' | 'uploading' | 'sealing'; percent: number };
}) {
  const t = documentCopy(locale);
  const status = uploadProgress ? t[uploadProgress.phase] : row.status === 'running' ? (t.phases[row.phase] ?? t.statuses.running) : (t.statuses[row.status] ?? row.status);
  const done = row.page_count && ['doc_ocr', 'doc_render'].includes(row.phase) ? Math.min(row.page_count,
    (row.progress.no_text ?? 0) + (row.progress.translated ?? 0) + (row.phase === 'doc_ocr' ? row.progress.ocr_done ?? 0 : 0)) : null;
  const dated = row.cancellable || ['succeeded', 'failed', 'cancelled'].includes(row.status);
  const expired = dated && Date.parse(row.expires_at) <= Date.now();
  return <li className="workbench-document-row" data-state={row.status} lang={t.lang}>
    <span className="record-kind" aria-hidden="true">{row.source_type === 'pdf' ? 'PDF' : 'ZIP'}</span>
    <div className="record-copy">
      <strong title={row.filename}>{row.filename}</strong>
      <small><span className="record-state" data-state={row.status}>{status}</span><span>{(row.byte_size / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 1 })} MB</span>{row.page_count !== null && <span>{format(t.pages, { count: row.page_count })}</span>}<span>{row.model.name}</span><span>{row.target_language}</span><span>{t.output}</span></small>
      {uploadProgress ? <div className="translation-progress" role="status"><span>{uploadProgress.percent}%</span><progress max={100} value={uploadProgress.percent} aria-label={status}/></div>
        : done !== null && <div className="translation-progress"><span>{format(t.pageProgress, { done, total: row.page_count! })}</span><progress max={row.page_count!} value={done} aria-label={status}/></div>}
      <small>{row.quota.reserved > 0 && <span>{format(t.reserved, { count: row.quota.reserved })}</span>}{(row.quota.used > 0 || row.status === 'succeeded') && <span>{format(t.used, { count: row.quota.used })}</span>}{row.quota.released > 0 && <span>{format(t.released, { count: row.quota.released })}</span>}</small>
      {row.status === 'awaiting_quota' && <div className="workbench-shortage"><p>{format(t.shortage, { needed: row.quota.needed ?? '—', available: row.quota.available ?? '—', difference: row.quota.difference ?? '—' })}</p><p>{t.manualResume} <a href={localPath('/pricing/', locale)}>{t.pricing}</a></p></div>}
      {row.status === 'outcome_unknown' && <p className="translation-note">{t.unknown}</p>}
      {row.error_code && row.status === 'failed' && <p className="translation-error">{documentError(row.error_code, t)}</p>}
      {dated && <small>{expired ? t.expired : <span>{t.expiry} <time dateTime={row.expires_at}>{new Date(row.expires_at).toLocaleString(locale)}</time></span>}</small>}
    </div>
    <div className="record-actions">
      {row.downloadable && !expired && <button className="button secondary" disabled={disabled} onClick={() => onAction(row, 'download')}>{t.download}</button>}
      {row.resumable && !expired && <button className="button" disabled={disabled} onClick={() => onAction(row, 'resume')}>{t.resume}</button>}
      {row.cancellable && <button className="text-link" disabled={disabled} onClick={() => onAction(row, 'cancel')}>{t.cancel}</button>}
    </div>
  </li>;
}
