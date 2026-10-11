import { useEffect, useMemo, useRef, useState } from 'react';
import { documentCopy, documentError } from '../i18n/documents';
import type { Locale } from '../i18n/locales';
import type { Account } from './translation-api';
import type { AuthIdentity } from './auth';
import type { DocumentCapabilities, DocumentHistory, DocumentInput, DocumentTask } from './document-api';

const pending = new Set(['uploading', 'preflight', 'queued', 'running', 'outcome_unknown']);
interface Scope { controller: AbortController; identity: AuthIdentity }
interface Draft { id: string; body: DocumentInput; completed: Set<number> }

/** One account-scoped history reader. Large-file code and its worker load only on demand. */
export function useDocumentTasks(account: Account | undefined, locale: Locale) {
  const t = documentCopy(locale);
  const identity = useMemo(() => account ? { id: account.sessionId, subject: account.subject } : undefined, [account?.sessionId, account?.subject]);
  const [caps, setCaps] = useState<DocumentCapabilities>();
  const [file, setFile] = useState<File>();
  const [rows, setRows] = useState<DocumentTask[]>([]), [before, setBefore] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [actionId, setActionId] = useState('');
  const [progress, setProgress] = useState<{ phase: 'hashing' | 'uploading' | 'sealing'; percent: number }>();
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const scope = useRef<Scope | undefined>(undefined), uploadController = useRef<AbortController | undefined>(undefined);
  const draft = useRef<Draft | undefined>(undefined), working = useRef(false);
  const fail = (error: unknown) => setError(documentError(error instanceof Error ? error.message : 'NETWORK_ERROR', t));

  useEffect(() => {
    scope.current?.controller.abort(); uploadController.current?.abort();
    working.current = false; draft.current = undefined; scope.current = undefined;
    setCaps(undefined); setRows([]); setBefore(null); setNextCursor(null);
    setFile(undefined); setBusy(false); setActionId(''); setProgress(undefined); setNotice(''); setError('');
    if (!identity) return;
    const context: Scope = { controller: new AbortController(), identity };
    scope.current = context;
    void import('./document-api').then(api => api.documentRequest<DocumentCapabilities>('/capabilities', identity, { signal: context.controller.signal }))
      .then(result => { if (!context.controller.signal.aborted) setCaps(result); })
      .catch(error => { if (!context.controller.signal.aborted) fail(error); });
    return () => { context.controller.abort(); uploadController.current?.abort(); };
  }, [identity]);

  useEffect(() => {
    if (!identity || !scope.current) return;
    const context = scope.current, controller = new AbortController();
    const signal = AbortSignal.any([context.controller.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined, reading = false, hasPending = false;
    async function read(force = false) {
      if (reading || signal.aborted || (!force && document.hidden)) return;
      clearTimeout(timer); reading = true;
      if (force) setLoading(true);
      try {
        const { documentRequest } = await import('./document-api');
        const result = await documentRequest<DocumentHistory>('?limit=20' + (before ? '&before=' + encodeURIComponent(before) : ''), identity!, { signal });
        signal.throwIfAborted();
        setRows(old => result.items.map(row => old.find(item => item.id === row.id && item.version > row.version) ?? row));
        setNextCursor(result.next_cursor);
        hasPending = result.items.some(row => pending.has(row.status));
        // A lost sealing response is resolved by the authoritative history, not another upload.
        const receipt = !working.current && draft.current && result.items.find(row => row.id === draft.current?.id && row.status !== 'uploading');
        if (receipt) {
          draft.current = undefined; setFile(undefined); setProgress(undefined);
          if (['failed', 'cancelled'].includes(receipt.status)) { setNotice(''); fail(Error(receipt.error_code ?? 'DOCUMENT_UPLOAD_CLOSED')); }
          else { setError(''); setNotice(t.confirmed); }
        }
      } catch (error) { if (!signal.aborted && force) fail(error); }
      finally {
        reading = false;
        if (!signal.aborted) {
          setLoading(false);
          if (hasPending && !document.hidden) timer = setTimeout(() => { void read(); }, 5000);
        }
      }
    }
    const visible = () => { clearTimeout(timer); if (!document.hidden && hasPending) void read(); };
    document.addEventListener('visibilitychange', visible);
    void read(true);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [identity, before, refresh]);

  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  function updateRow(row: DocumentTask) {
    setRows(old => [row, ...old.filter(item => item.id !== row.id)].slice(0, 20));
  }
  function selectFile(selected?: File) {
    if (working.current || draft.current || identity?.id !== scope.current?.identity.id) return;
    setError(''); setNotice(''); setProgress(undefined); setFile(selected);
  }
  async function upload(language: string, modelId: string) {
    if (!identity || !file || !caps?.enabled || working.current) return;
    const context = scope.current!, controller = new AbortController();
    const signal = AbortSignal.any([context.controller.signal, controller.signal]);
    uploadController.current = controller; working.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      const api = await import('./document-api');
      signal.throwIfAborted();
      if (!draft.current) {
        if (!file.size || file.size > Math.min(caps.limits.max_bytes, 200_000_000)) throw new api.DocumentError('DOCUMENT_SOURCE_TOO_LARGE');
        if (!caps.models.some(item => item.id === modelId) || !caps.languages.some(item => item.id === language)) throw new api.DocumentError('MODEL_DOCUMENT_UNSUPPORTED');
        setProgress({ phase: 'hashing', percent: 0 });
        const sha256 = await api.hashDocument(file, signal, bytes => setProgress({ phase: 'hashing', percent: Math.round(bytes / file.size * 100) }));
        signal.throwIfAborted();
        draft.current = { id: crypto.randomUUID(), completed: new Set(), body: {
          filename: file.name, source_type: api.documentSourceType(file.name), byte_size: file.size, sha256,
          target_language: language, model_id: modelId,
        } };
      }
      const intent = draft.current;
      let task = await api.documentRequest<DocumentTask>('/' + intent.id, identity, { method: 'PUT', body: JSON.stringify(intent.body), signal });
      signal.throwIfAborted(); updateRow(task);
      if (task.status === 'uploading') {
        if (!task.upload) throw new api.DocumentError('DOCUMENT_UPLOAD_CLOSED');
        setProgress({ phase: 'uploading', percent: 0 });
        await api.uploadDocumentParts(intent.id, file, task.upload.part_bytes, intent.completed, identity, signal,
          bytes => setProgress({ phase: 'uploading', percent: Math.round(bytes / file.size * 100) }));
        setProgress({ phase: 'sealing', percent: 100 });
        task = await api.documentRequest<DocumentTask>('/' + intent.id + '/complete-upload', identity, { method: 'POST', signal });
      }
      signal.throwIfAborted(); updateRow(task);
      if (['failed', 'cancelled'].includes(task.status)) {
        draft.current = undefined; setFile(undefined); setProgress(undefined);
        throw new api.DocumentError(task.error_code ?? 'DOCUMENT_UPLOAD_CLOSED');
      }
      if (task.status === 'uploading') throw new api.DocumentError('DOCUMENT_UPLOAD_CLOSED');
      setNotice(t.confirmed); draft.current = undefined; setFile(undefined); setProgress(undefined);
    } catch (error) {
      if (!signal.aborted) { fail(error); setNotice(t.notConfirmed); }
    } finally {
      if (scope.current === context) {
        working.current = false; setBusy(false); setBefore(null); setRefresh(value => value + 1);
      }
      if (uploadController.current === controller) uploadController.current = undefined;
    }
  }
  async function action(row: DocumentTask, operation: 'cancel' | 'resume' | 'download') {
    if (!identity || actionId || (operation === 'cancel' && !row.cancellable) ||
      (operation === 'resume' && !row.resumable) || (operation === 'download' && !row.downloadable)) return;
    const context = scope.current!, signal = context.controller.signal;
    setActionId(row.id); setError('');
    if (operation === 'cancel' && draft.current?.id === row.id) uploadController.current?.abort();
    try {
      const api = await import('./document-api');
      if (operation === 'download') {
        const result = await api.documentRequest<{ url: string }>('/' + row.id + '/download', identity, { signal });
        signal.throwIfAborted();
        const anchor = document.createElement('a');
        anchor.href = api.signedObjectUrl(result.url); anchor.rel = 'noreferrer';
        anchor.download = row.filename.replace(/\.[^.]+$/, '') + '-translated.zip';
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
      } else {
        const result = await api.documentRequest<DocumentTask>('/' + row.id + '/' + operation, identity, { method: 'POST', signal });
        signal.throwIfAborted(); updateRow(result);
        if (operation === 'cancel' && draft.current?.id === row.id) {
          draft.current = undefined; setFile(undefined); setProgress(undefined); setNotice('');
        }
      }
    } catch (error) { if (!signal.aborted) fail(error); }
    finally { if (!signal.aborted) { setActionId(''); setRefresh(value => value + 1); } }
  }
  async function refreshAll() {
    setError(''); setRefresh(value => value + 1);
    const context = scope.current;
    if (!context) return;
    try {
      const api = await import('./document-api');
      const result = await api.documentRequest<DocumentCapabilities>('/capabilities', context.identity, { signal: context.controller.signal });
      if (!context.controller.signal.aborted) setCaps(result);
    } catch (error) { if (!context.controller.signal.aborted) fail(error); }
  }
  return { caps, file, rows, before, nextCursor, loading, busy, actionId, progress, error, notice,
    draftId: draft.current?.id, frozen: draft.current?.body, selectFile, upload, action, refreshAll,
    page: (cursor: string | null) => { setRows([]); setBefore(cursor); },
  };
}
