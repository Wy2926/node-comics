import { useEffect, useRef, useState } from 'react';
import { documentCopy, documentError, documentFormat as format } from '../i18n/documents';
import { localPath, type Locale } from '../i18n/locales';
import { sessionIdentity, signIn, subscribeAuth, type AuthIdentity } from '../lib/auth';
import { DocumentError, documentRequest, documentSourceType, hashDocument, signedObjectUrl, uploadDocumentParts,
  type DocumentCapabilities, type DocumentHistory, type DocumentInput, type DocumentTask } from '../lib/document-api';
import '../styles/document.css';

const pending = new Set(['uploading', 'preflight', 'queued', 'running', 'outcome_unknown']);
interface Scope { controller: AbortController; identity?: AuthIdentity }
interface Draft { id: string; body: DocumentInput; modelName: string; completed: Set<number> }

export default function DocumentWorkbench({ locale }: { locale: Locale }) {
  const t = documentCopy(locale);
  const [identity, setIdentity] = useState<AuthIdentity>(), [ready, setReady] = useState(false);
  const [caps, setCaps] = useState<DocumentCapabilities>(), [file, setFile] = useState<File>();
  const [modelId, setModelId] = useState(''), [language, setLanguage] = useState(locale === 'zh-CN' ? 'zh-Hans' : locale === 'zh-TW' ? 'zh-Hant' : locale);
  const [rows, setRows] = useState<DocumentTask[]>([]), [before, setBefore] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false), [busy, setBusy] = useState(false), [actionId, setActionId] = useState('');
  const [progress, setProgress] = useState<{ phase: 'hashing' | 'uploading' | 'sealing'; percent: number }>();
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const scope = useRef<Scope | undefined>(undefined), uploadController = useRef<AbortController | undefined>(undefined);
  const draft = useRef<Draft | undefined>(undefined), working = useRef(false), fileInput = useRef<HTMLInputElement>(null);
  const hasDraft = !!draft.current;
  const models = draft.current ? [{ id: draft.current.body.model_id, name: draft.current.modelName }] : caps?.models ?? [];
  const allowed = !!(caps?.enabled && (hasDraft || caps.paid_allowed && models.some(item => item.id === modelId)));
  const fail = (error: unknown) => setError(documentError(error instanceof DocumentError ? error.code : 'NETWORK_ERROR', t));

  function applyCaps(result: DocumentCapabilities) {
    setCaps(result);
    setModelId(current => draft.current?.body.model_id ?? (result.models.some(item => item.id === current) ? current : result.models[0]?.id ?? ''));
    setLanguage(current => draft.current?.body.target_language ?? (result.languages.some(item => item.id === current) ? current : result.languages[0]?.id ?? ''));
  }
  useEffect(() => {
    let disposed = false;
    async function load() {
      scope.current?.controller.abort(); uploadController.current?.abort();
      const context: Scope = { controller: new AbortController() };
      scope.current = context;
      working.current = false; draft.current = undefined;
      setIdentity(undefined); setCaps(undefined); setRows([]); setBefore(null); setNextCursor(null);
      setFile(undefined); setBusy(false); setActionId(''); setProgress(undefined); setNotice(''); setError(''); setReady(false);
      if (fileInput.current) fileInput.current.value = '';
      try {
        const account = await sessionIdentity();
        if (disposed || scope.current !== context) return;
        if (account) {
          context.identity = account; setIdentity(account);
          const result = await documentRequest<DocumentCapabilities>('/capabilities', account, { signal: context.controller.signal });
          if (scope.current !== context) return;
          applyCaps(result);
        }
      } catch (error) { if (!context.controller.signal.aborted) fail(error); }
      finally { if (!disposed && scope.current === context) setReady(true); }
    }
    void load();
    const unsubscribe = subscribeAuth(() => { void load(); });
    return () => { disposed = true; unsubscribe(); scope.current?.controller.abort(); uploadController.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!identity) return;
    const context = scope.current!, controller = new AbortController();
    const signal = AbortSignal.any([context.controller.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined, loading = false, hasPending = false;
    async function read(force = false) {
      if (loading || signal.aborted || (!force && document.hidden)) return;
      clearTimeout(timer); loading = true;
      if (force) setHistoryLoading(true);
      try {
        const result = await documentRequest<DocumentHistory>('?limit=20' + (before ? '&before=' + encodeURIComponent(before) : ''), identity!, { signal });
        signal.throwIfAborted();
        setRows(old => result.items.map(row => {
          const newer = old.find(item => item.id === row.id && item.version > row.version);
          return newer ?? row;
        }));
        setNextCursor(result.next_cursor);
        hasPending = result.items.some(row => pending.has(row.status));
      } catch (error) { if (!signal.aborted && force) fail(error); }
      finally {
        loading = false;
        if (!signal.aborted) {
          setHistoryLoading(false);
          if (hasPending && !document.hidden) timer = setTimeout(() => { void read(); }, 5000);
        }
      }
    }
    const visible = () => {
      clearTimeout(timer);
      if (!document.hidden && hasPending) void read();
    };
    document.addEventListener('visibilitychange', visible);
    void read(true);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [identity?.id, before, refresh]);

  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  function updateRow(row: DocumentTask) {
    setRows(old => [row, ...old.filter(item => item.id !== row.id)].slice(0, 20));
  }
  function selectFile(selected?: File) {
    setError(''); setNotice(''); draft.current = undefined; setProgress(undefined); setFile(undefined);
    if (caps) applyCaps(caps);
    if (!selected) return;
    try {
      documentSourceType(selected.name);
      if (!selected.size || selected.size > Math.min(caps?.limits.max_bytes ?? 200_000_000, 200_000_000)) throw new DocumentError('DOCUMENT_SOURCE_TOO_LARGE');
      setFile(selected);
    } catch (error) { fail(error); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function upload() {
    if (!identity || !file || !allowed || working.current) return;
    const context = scope.current!, controller = new AbortController();
    const signal = AbortSignal.any([context.controller.signal, controller.signal]);
    uploadController.current = controller; working.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      if (!draft.current) {
        setProgress({ phase: 'hashing', percent: 0 });
        const sha256 = await hashDocument(file, signal, bytes => setProgress({ phase: 'hashing', percent: Math.round(bytes / file.size * 100) }));
        signal.throwIfAborted();
        draft.current = { id: crypto.randomUUID(), modelName: caps!.models.find(item => item.id === modelId)!.name, completed: new Set(), body: {
          filename: file.name, source_type: documentSourceType(file.name), byte_size: file.size, sha256,
          target_language: language, model_id: modelId,
        } };
      }
      const intent = draft.current;
      let task = await documentRequest<DocumentTask>('/' + intent.id, identity,
        { method: 'PUT', body: JSON.stringify(intent.body), signal });
      signal.throwIfAborted(); updateRow(task); setBefore(null); setRefresh(value => value + 1);
      if (task.status === 'uploading') {
        if (!task.upload) throw new DocumentError('DOCUMENT_UPLOAD_CLOSED');
        setProgress({ phase: 'uploading', percent: 0 });
        await uploadDocumentParts(intent.id, file, task.upload.part_bytes, intent.completed, identity, signal,
          bytes => setProgress({ phase: 'uploading', percent: Math.round(bytes / file.size * 100) }));
        setProgress({ phase: 'sealing', percent: 100 });
        task = await documentRequest<DocumentTask>('/' + intent.id + '/complete-upload', identity, { method: 'POST', signal });
      }
      signal.throwIfAborted();
      if (['uploading', 'failed', 'cancelled'].includes(task.status)) throw new DocumentError('DOCUMENT_UPLOAD_CLOSED');
      updateRow(task); setNotice(t.confirmed); draft.current = undefined; setFile(undefined); setProgress(undefined);
      if (fileInput.current) fileInput.current.value = '';
      setRefresh(value => value + 1);
    } catch (error) {
      if (!signal.aborted) { fail(error); setNotice(t.notConfirmed); setRefresh(value => value + 1); }
    } finally {
      if (scope.current === context) { working.current = false; setBusy(false); }
      if (uploadController.current === controller) uploadController.current = undefined;
    }
  }
  async function action(row: DocumentTask, operation: 'cancel' | 'resume' | 'download') {
    if (!identity || actionId) return;
    const context = scope.current!, signal = context.controller.signal;
    setActionId(row.id); setError('');
    if (operation === 'cancel' && draft.current?.id === row.id) uploadController.current?.abort();
    try {
      if (operation === 'download') {
        const result = await documentRequest<{ url: string }>('/' + row.id + '/download', identity, { signal });
        signal.throwIfAborted();
        const anchor = document.createElement('a');
        anchor.href = signedObjectUrl(result.url); anchor.rel = 'noreferrer';
        anchor.download = row.filename.replace(/\.[^.]+$/, '') + '-translated.zip';
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
      } else {
        const result = await documentRequest<DocumentTask>('/' + row.id + '/' + operation, identity, { method: 'POST', signal });
        signal.throwIfAborted(); updateRow(result);
        if (operation === 'cancel' && draft.current?.id === row.id) {
          draft.current = undefined; setFile(undefined); setProgress(undefined); setNotice('');
          if (fileInput.current) fileInput.current.value = '';
        }
      }
    } catch (error) { if (!signal.aborted) fail(error); }
    finally { if (!signal.aborted) { setActionId(''); setRefresh(value => value + 1); } }
  }
  async function refreshAll() {
    setError(''); setRefresh(value => value + 1);
    const context = scope.current;
    if (!context?.identity) return;
    try {
      const result = await documentRequest<DocumentCapabilities>('/capabilities', context.identity, { signal: context.controller.signal });
      if (!context.controller.signal.aborted) applyCaps(result);
    } catch (error) { if (!context.controller.signal.aborted) fail(error); }
  }

  return <section id="documents" className="container document-workbench" lang={t.lang} dir="ltr" aria-labelledby="document-title">
    <header className="document-heading"><span className="document-kicker">PDF / ZIP / CBZ</span><h2 id="document-title">{t.title}</h2><p>{t.intro}</p></header>
    <div className="document-composer">
      <p className="document-limits">{t.limits}</p><p className="document-rule">{t.quotaRule}</p>
      {!ready ? <p role="status">{t.loading}</p> : !identity ? <div className="document-access"><p>{t.paid}</p><button className="button" onClick={() => { void signIn(localPath('/translate/', locale)).catch(fail); }}>{t.login}</button><a href={localPath('/pricing/', locale)}>{t.pricing} ↗</a></div>
        : !caps?.enabled ? <p role="status">{t.disabled}</p>
          : !caps.paid_allowed && !hasDraft ? <div className="document-access"><p>{t.paid}</p><a className="button" href={localPath('/pricing/', locale)}>{t.pricing} ↗</a></div>
            : !models.length ? <p role="status">{t.noModels}</p>
              : <>
                <label className="document-file" htmlFor="document-file"><span>{t.choose}</span><input ref={fileInput} id="document-file" type="file" accept=".pdf,.zip,.cbz,application/pdf,application/zip,application/x-cbz" disabled={busy} onChange={event => selectFile(event.currentTarget.files?.[0])}/></label>
                {file && <p className="document-selected">{file.name} <span>{(file.size / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 1 })} MB</span></p>}
                <div className="document-settings"><label htmlFor="document-language">{t.language}<select id="document-language" value={language} disabled={busy || !!draft.current} onChange={event => setLanguage(event.target.value)}>{caps.languages.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                  <label htmlFor="document-model">{t.model}<select id="document-model" value={modelId} disabled={busy || hasDraft} onChange={event => setModelId(event.target.value)}>{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                  <button className="button" disabled={!file || busy || !allowed} onClick={() => { void upload(); }}>{busy ? t[progress?.phase ?? 'uploading'] : draft.current ? t.retryUpload : t.upload}</button></div>
              </>}
      {progress && <div className="document-progress" role="status"><span>{t[progress.phase]} · {progress.percent}%</span><progress max="100" value={progress.percent} aria-label={t[progress.phase]}/></div>}
      <p className="document-privacy">{t.privacy}</p>
    </div>
    {error && <p className="document-message document-error" role="alert">{error}</p>}
    {notice && <p className="document-message" role="status">{notice}</p>}
    {identity && <div className="document-history"><header><div><h3>{t.history}</h3><p>{t.historyHint}</p></div><button className="button secondary" disabled={historyLoading} onClick={() => { void refreshAll(); }}>{t.refresh}</button></header>
      {historyLoading && !rows.length ? <p role="status">{t.loading}</p> : !rows.length ? <p className="document-empty">{t.empty}</p> : <ol className="document-tasks">{rows.map(row => {
        const status = row.status === 'running' ? (t.phases[row.phase] ?? t.statuses.running) : (t.statuses[row.status] ?? row.status);
        const pageProgress = row.page_count && ['doc_ocr', 'doc_render'].includes(row.phase) ? Math.min(row.page_count,
          (row.progress.no_text ?? 0) + (row.progress.translated ?? 0) + (row.phase === 'doc_ocr' ? row.progress.ocr_done ?? 0 : 0)) : null;
        const dated = row.cancellable || ['succeeded', 'failed', 'cancelled'].includes(row.status);
        const expired = dated && Date.parse(row.expires_at) <= Date.now();
        return <li key={row.id} className="document-task" data-status={row.status}>
          <div className="document-task-title"><h4>{row.filename}</h4><span className="document-status">{status}</span></div>
          <p className="document-meta"><span>{(row.byte_size / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 1 })} MB</span>{row.page_count !== null && <span>{format(t.pages, { count: row.page_count })}</span>}<span>{row.model.name}</span><span>{caps?.languages.find(item => item.id === row.target_language)?.label ?? row.target_language}</span></p>
          {pageProgress !== null && <div className="document-progress"><span>{format(t.pageProgress, { done: pageProgress, total: row.page_count! })}</span><progress max={row.page_count!} value={pageProgress} aria-label={status}/></div>}
          <p className="document-quota">{row.quota.reserved > 0 && <span>{format(t.reserved, { count: row.quota.reserved })}</span>}{(row.quota.used > 0 || row.status === 'succeeded') && <span>{format(t.used, { count: row.quota.used })}</span>}{row.quota.released > 0 && <span>{format(t.released, { count: row.quota.released })}</span>}</p>
          {row.status === 'awaiting_quota' && <div className="document-shortage"><strong>{format(t.shortage, { needed: row.quota.needed ?? '—', available: row.quota.available ?? '—', difference: row.quota.difference ?? '—' })}</strong><p>{t.manualResume}</p><a href={localPath('/pricing/', locale)}>{t.pricing} ↗</a></div>}
          {row.status === 'outcome_unknown' && <p className="document-task-note">{t.unknown}</p>}
          {row.error_code && row.status === 'failed' && <p className="document-error">{documentError(row.error_code, t)}</p>}
          {dated && <p className="document-expiry">{expired ? t.expired : <>{t.expiry} <time dateTime={row.expires_at}>{new Date(row.expires_at).toLocaleString(locale)}</time></>}</p>}
          <div className="document-actions">{row.downloadable && !expired && <button className="button" disabled={!!actionId} onClick={() => { void action(row, 'download'); }}>{t.download} ↓</button>}
            {row.resumable && !expired && <button className="button" disabled={!!actionId} onClick={() => { void action(row, 'resume'); }}>{t.resume}</button>}
            {row.cancellable && <button className="button secondary" disabled={!!actionId} onClick={() => { void action(row, 'cancel'); }}>{t.cancel}</button>}</div>
        </li>;
      })}</ol>}
      <nav className="document-pagination" aria-label={t.history}>{before && <button className="button secondary" disabled={historyLoading} onClick={() => { setRows([]); setBefore(null); }}>{t.latest}</button>}{nextCursor && <button className="button secondary" disabled={historyLoading || busy} onClick={() => { setRows([]); setBefore(nextCursor); }}>{t.older}</button>}</nav>
    </div>}
  </section>;
}
