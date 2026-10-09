import { useEffect, useRef, useState } from 'react';
import ImageDropzone from './ImageDropzone';
import Turnstile from './Turnstile';
import { translationError } from '../i18n/translation-error';
import type { TranslationCopy } from '../i18n/translate';
import { translationCacheCopy } from '../i18n/translation-cache';
import { localPath, type Locale } from '../i18n/locales';
import { signIn, subscribeAuth } from '../lib/auth';
import {
  blobBytes,
  draftScope,
  listRecords,
  localSnapshotState,
  readImages,
  recordOrder,
  removeRecord,
  removeRecords,
  saveRecord,
  storageBytes,
  type RecordMeta,
  type Snapshot,
} from '../lib/translation-store';
import {
  currentAccount,
  json,
  request,
  watch,
  TranslationError,
  type Account,
  type Guest,
  type Capabilities,
} from '../lib/translation-api';
import { pixels } from '../lib/translation-pixels';
import { saveDownload, translationArchive, translationFilename } from '../lib/translation-download';
import '../styles/translate.css';

const active = new Set([
  'needs_input',
  'queued',
  'running',
  'preparing',
  'submitting',
  'receiving',
  'paused',
]);
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });

export default function TranslationWorkbench({ locale, copy: t }: { locale: Locale; copy: TranslationCopy }) {
  const cacheCopy = translationCacheCopy[locale];
  const [rows, setRows] = useState<RecordMeta[]>([]),
    [account, setAccount] = useState<Account>(),
    [guest, setGuest] = useState<Guest>(),
    [caps, setCaps] = useState<Capabilities>(),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [downloading, setDownloading] = useState(false),
    [importing, setImporting] = useState(false),
    [clearing, setClearing] = useState(false),
    [cacheNotice, setCacheNotice] = useState(''),
    [language, setLanguage] = useState(
      locale === 'zh-CN' ? 'zh-Hans' : locale === 'zh-TW' ? 'zh-Hant' : locale === 'pt-BR' ? 'pt' : locale,
    ),
    [showGuest, setShowGuest] = useState(false),
    [volatile, setVolatile] = useState<{ id: string; blob: Blob }>();
  const [check, setCheck] = useState<{ id: string; action: string }>();
  const verification = useRef<
    | { resolve: (token: string) => void; reject: (error: Error) => void }
    | undefined
  >(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);
  const exporting = useRef(false);
  const removing = useRef(false);
  const resumeOnReturn = useRef(false);
  const runningIds = useRef<string[]>([]);
  const resumePending = useRef<() => void>(() => undefined);
  const verificationDialog = useRef<HTMLDivElement>(null);
  const guestRef = useRef<Guest | undefined>(undefined);
  const scopes = useRef<string[]>([]);
  const [hasGuestHistory, setHasGuestHistory] = useState(false);
  const [usedBytes, setUsedBytes] = useState(0);
  const isGuestScope = showGuest || !account;
  const languages =
    caps?.languages.filter((item) =>
      caps.modes.find((item) => item.id === 'classic')?.languages.includes(item.id),
    ) ?? [];
  useEffect(() => {
    if (caps && !languages.some((item) => item.id === language))
      setLanguage(languages[0]?.id ?? '');
  }, [caps]);
  async function refresh() {
    const [found, used] = await Promise.all([
      listRecords(scopes.current),
      storageBytes(),
    ]);
    setRows(found);
    setUsedBytes(used);
  }
  function fail(error: unknown) {
    const code =
      error instanceof TypeError ||
      (error instanceof Error &&
        ['AbortError', 'TimeoutError'].includes(error.name))
        ? 'NETWORK_ERROR'
        : error instanceof Error
          ? error.message
          : '';
    setError(translationError(code, t));
  }
  async function commit(
    meta: RecordMeta,
    data?: Parameters<typeof saveRecord>[1],
  ) {
    meta.updated = Date.now();
    setUsedBytes(await saveRecord(meta, data));
    if (scopes.current.includes(meta.scope) || scopes.current.includes('guest:*') && meta.scope.startsWith('guest:'))
      setRows((old) => [...old.filter((row) => row.id !== meta.id), { ...meta }].sort(recordOrder));
  }
  useEffect(() => {
    let generation = 0;
    const load = async () => {
      const started = ++generation;
      const gone = () => started !== generation;
      try {
        const identity = await currentAccount();
        if (gone()) return;
        setAccount(identity);
        scopes.current = [
          draftScope(),
          identity ? 'user:' + identity.id : 'guest:*',
        ];
        const [found, used, guestHistory] = await Promise.all([
          listRecords(scopes.current), storageBytes(), listRecords(['guest:*']),
        ]);
        if (gone()) return;
        setRows(found); setUsedBytes(used); setHasGuestHistory(guestHistory.length > 0);
        const [visitor, capabilities] = await Promise.all([
          json<Guest>('/v1/guest/session'),
          json<Capabilities>('/v1/capabilities', {}, identity),
        ]);
        if (gone()) return;
        if (capabilities.result_protocol !== 'overlay-v1')
          throw Error('CLIENT_UPGRADE_REQUIRED');
        setGuest(visitor);
        guestRef.current = visitor;
        setCaps(capabilities);
        setReady(true);
      } catch (error) {
        if (!gone()) fail(error);
      }
    };
    void load();
    const unsubscribe = subscribeAuth(() => {
      controller.current?.abort(Error('AUTH_REQUIRED'));
      resumeOnReturn.current = false;
      verification.current?.reject(Error('AUTH_REQUIRED'));
      setAccount(undefined); setCaps(undefined); setReady(false); setRows([]); setShowGuest(false);
      void load();
    });
    return () => {
      generation++;
      unsubscribe();
      resumeOnReturn.current = false;
      resumePending.current = () => undefined;
      controller.current?.abort();
      verification.current?.reject(Error('NETWORK_ERROR'));
    };
  }, []);
  useEffect(() => {
    if (ready) {
      const pending = rows.filter(
        (row) => row.requestId && active.has(row.state),
      );
      if (pending.length) void run(pending);
    }
  }, [ready]);
  resumePending.current = () => {
    if (!resumeOnReturn.current || running.current || !ready ||
        document.hidden || !navigator.onLine) return;
    void listRecords(scopes.current).then((found) => {
      if (!resumeOnReturn.current || running.current || document.hidden || !navigator.onLine) return;
      resumeOnReturn.current = false;
      void run(found.filter((row) => runningIds.current.includes(row.id) && row.requestId && active.has(row.state)));
    }).catch(fail);
  };
  useEffect(() => {
    function visibility() {
      if (document.hidden || !navigator.onLine) {
        if (running.current) {
          resumeOnReturn.current = true;
          controller.current?.abort(Error('BACKGROUND_PAUSED'));
        }
      } else resumePending.current();
    }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('offline', visibility);
    window.addEventListener('online', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('offline', visibility);
      window.removeEventListener('online', visibility);
    };
  }, []);
  useEffect(() => {
    if (!check) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = verificationDialog.current;
    const close = dialog?.querySelector<HTMLButtonElement>('button');
    close?.focus({ preventScroll: true });
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog?.contains(event.target))
        close?.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      previous?.focus({ preventScroll: true });
    };
  }, [!!check]);
  function pause() {
    resumeOnReturn.current = false;
    controller.current?.abort(Error('USER_PAUSED'));
  }
  async function changeHistory(value: boolean) {
    setShowGuest(value);
    scopes.current = [
      draftScope(),
      ...(value || !account ? ['guest:*'] : ['user:' + account.id]),
    ];
    await refresh();
  }
  function challenge(action: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const finish = (token?: string, error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        verification.current = undefined;
        if (error) setCheck(undefined);
        error ? reject(error) : resolve(token!);
      };
      const cancel = () => finish(undefined, signal.reason);
      const timer = setTimeout(
        () => finish(undefined, Error('VERIFICATION_FAILED')),
        120000,
      );
      verification.current = {
        resolve: (token) => finish(token),
        reject: (error) => finish(undefined, error),
      };
      signal.addEventListener('abort', cancel, { once: true });
      setCheck({ id: crypto.randomUUID(), action });
    });
  }
  async function run(candidates: RecordMeta[]) {
    if (!candidates.length || running.current || removing.current || importing || !caps || !ready) return;
    runningIds.current = candidates.map((row) => row.id);
    if (document.hidden || !navigator.onLine) {
      resumeOnReturn.current = candidates.some((row) => !!row.requestId);
      return;
    }
    resumeOnReturn.current = false;
    running.current = true;
    setBusy(true);
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    let currentMeta: RecordMeta | undefined;
    try {
      for (const stored of candidates) {
        abort.signal.throwIfAborted();
        const meta = { ...stored };
        currentMeta = meta;
        let data = await readImages(meta.id);
        if (!data) throw Error('LOCAL_STORAGE_UNAVAILABLE');
        const useAccount = meta.scope.startsWith('user:')
          ? account
          : meta.scope.startsWith('guest:')
            ? undefined
            : isGuestScope
              ? undefined
              : account;
        if (
          meta.scope.startsWith('user:') &&
          meta.scope !== 'user:' + useAccount?.id
        )
          throw Error('AUTH_REQUIRED');
        if (data.result && meta.state === 'succeeded') continue;
        if (
          meta.requestId &&
          meta.scope.startsWith('guest:') &&
          meta.scope !== 'guest:' + guestRef.current?.user_id
        )
          throw Error('GUEST_SESSION_EXPIRED');
        if (!meta.requestId) {
          meta.mode = 'classic';
          meta.language = language;
        }
        const allowTiles = meta.requestId
          ? meta.resultFormat === 'overlay-tiles-v1'
          : meta.mode === 'classic' && !!caps.representations?.includes('overlay-tiles-v1');
        // Existing UUIDs must keep their durable input, including after encoder/capability changes.
        if (meta.requestId && !data.input) throw new TranslationError('LOCAL_INPUT_MISSING');
        if (!data.input) {
          meta.state = 'preparing';
          meta.error = undefined;
          await commit(meta);
          let prepared;
          try {
            prepared = await pixels(data.source, caps.limits, undefined, undefined, allowTiles);
          } catch (error) {
            abort.signal.throwIfAborted();
            meta.state = 'failed';
            meta.error =
              error instanceof Error
                ? error.message
                : 'IMAGE_PROCESSING_FAILED';
            await commit(meta);
            continue;
          }
          abort.signal.throwIfAborted();
          data = { ...data, input: prepared.input };
          Object.assign(meta, {
            width: prepared.width,
            height: prepared.height,
            sha256: prepared.sha256,
            mime: prepared.mime,
            inputBytes: prepared.input.size,
            bytes: blobBytes(data),
            state: 'draft',
          });
          await commit(meta, data);
        }
        if (!meta.requestId && !meta.intent) {
          if (Math.max(meta.width!, meta.height!) > 16383) {
            if (!allowTiles) {
              meta.state = 'failed';
              meta.error = 'RESULT_FORMAT_UNAVAILABLE';
              await commit(meta);
              continue;
            }
            meta.resultFormat = 'overlay-tiles-v1';
          } else delete meta.resultFormat;
        }
        if (!useAccount) {
          if (!guestRef.current?.user_id) {
            if (!guestRef.current?.enabled) throw Error('GUEST_UNAVAILABLE');
            const token = await challenge('guest_session', abort.signal);
            guestRef.current = await json<Guest>('/v1/guest/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token }),
              signal: abort.signal,
            });
            setGuest(guestRef.current);
            scopes.current = [draftScope(), 'guest:*'];
          }
          if (
            meta.scope.startsWith('guest:') &&
            meta.scope !== 'guest:' + guestRef.current.user_id
          )
            throw Error('GUEST_SESSION_EXPIRED');
        }
        meta.scope = useAccount
          ? 'user:' + useAccount.id
          : 'guest:' + guestRef.current!.user_id;
        if (!useAccount) setHasGuestHistory(true);
        meta.requestId ??= crypto.randomUUID();
        meta.state = meta.snapshot
          ? localSnapshotState(meta.snapshot, !!data.result)
          : 'submitting';
        await commit(meta); // Images are already durable; freeze identity before create/upload.
        const path = useAccount ? '/v1/translations' : '/v1/guest/translations';
        let snapshot: Snapshot | undefined;
        try {
          snapshot = await json<Snapshot>(
            path + '/' + meta.requestId,
            { signal: abort.signal },
            useAccount,
          );
        } catch (error) {
          if (!(error instanceof TranslationError && error.status === 404))
            throw error;
        }
        if (!snapshot) {
          // Older local records remain readable, but cannot create retired modes.
          if (meta.mode !== 'classic') throw new TranslationError('TRANSLATION_UNAVAILABLE');
          const token = useAccount
            ? ''
            : await challenge('guest_translate', abort.signal);
          abort.signal.throwIfAborted();
          snapshot = await json<Snapshot>(
            path + '/' + meta.requestId,
            {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'X-Turnstile-Token': token } : {}),
              },
              body: JSON.stringify(
                meta.intent ?? {
                  image: {
                    sha256: meta.sha256,
                    byte_size: meta.inputBytes,
                    content_type: meta.mime,
                    normalization_version: 1,
                  },
                  mode: meta.mode,
                  target_language: meta.language,
                  ...(meta.resultFormat ? { result_format: meta.resultFormat } : {}),
                },
              ),
              signal: abort.signal,
            },
            useAccount,
          );
        }
        setCheck(undefined);
        const receive = async (value: Snapshot) => {
          abort.signal.throwIfAborted();
          snapshot = value;
          meta.snapshot = value;
          meta.state = localSnapshotState(value, !!data?.result);
          meta.error = value.error?.code;
          await commit(meta);
        };
        await receive(snapshot);
        if (snapshot.state === 'needs_input') {
          snapshot = await json<Snapshot>(
            path + '/' + meta.requestId + '/input',
            {
              method: 'PUT',
              headers: { 'Content-Type': meta.mime! },
              body: data.input,
              signal: abort.signal,
            },
            useAccount,
          );
          await receive(snapshot);
        }
        let failures = 0;
        while (
          snapshot &&
          ['queued', 'running', 'needs_input'].includes(snapshot.state)
        ) {
          abort.signal.throwIfAborted();
          let reason: 'complete' | 'reconnect';
          try {
            reason = await watch(
              path,
              meta.requestId,
              useAccount,
              abort.signal,
              receive,
            );
            failures = 0;
          } catch (error) {
            if (abort.signal.aborted) throw error;
            const networkError = error instanceof TypeError ||
              error instanceof Error && error.name === 'TimeoutError' ||
              error instanceof TranslationError &&
                (error.code === 'NETWORK_ERROR' || error.status === 429 || error.status >= 500);
            if (!networkError) throw error;
            if (!['queued', 'running', 'needs_input'].includes(snapshot.state))
              break;
            if (
              error instanceof TranslationError &&
              (error.status === 401 ||
                error.status === 403 ||
                error.status === 404 ||
                error.status === 410)
            )
              throw error;
            if (++failures >= 3) throw error;
            await delay(
              Math.max(
                1000 * 2 ** failures,
                error instanceof TranslationError ? error.retryAfter * 1000 : 0,
              ),
              abort.signal,
            );
            continue;
          }
          if (reason === 'complete' &&
              ['queued', 'running', 'needs_input'].includes(snapshot.state)) {
            await receive(await json<Snapshot>(
              path + '/' + meta.requestId, { signal: abort.signal }, useAccount,
            ));
            if (['queued', 'running', 'needs_input'].includes(snapshot.state))
              throw new TranslationError('NETWORK_ERROR');
          }
          if (snapshot.state === 'needs_input') {
            await receive(
              await json<Snapshot>(
                path + '/' + meta.requestId + '/input',
                {
                  method: 'PUT',
                  headers: { 'Content-Type': meta.mime! },
                  body: data.input,
                  signal: abort.signal,
                },
                useAccount,
              ),
            );
          }
        }
        if (snapshot?.state === 'succeeded') {
          if (!snapshot.result) throw new TranslationError('NETWORK_ERROR');
          const artifact = snapshot.result.artifact
            ? await (
                await request(
                  path + '/' + meta.requestId + '/result',
                  { signal: abort.signal },
                  useAccount,
                )
              ).blob()
            : undefined;
          const output = (
            await pixels(data.input!, caps.limits, snapshot.result, artifact)
          ).result!;
          abort.signal.throwIfAborted();
          data = { ...data, result: output };
          meta.bytes = blobBytes(data);
          meta.state = 'succeeded';
          try {
            await commit(meta, data);
            abort.signal.throwIfAborted();
            setVolatile(undefined);
          } catch {
            abort.signal.throwIfAborted();
            setVolatile({ id: meta.id, blob: output });
            throw Error('RESULT_SAVE_FAILED');
          }
        }
        if (!useAccount) {
          const visitor = await json<Guest>('/v1/guest/session', { signal: abort.signal });
          abort.signal.throwIfAborted();
          guestRef.current = visitor;
          setGuest(guestRef.current);
        } else {
          const capabilities = await json<Capabilities>('/v1/capabilities', { signal: abort.signal }, useAccount);
          abort.signal.throwIfAborted();
          setCaps(capabilities);
        }
      }
    } catch (error) {
      if (currentMeta &&
          error instanceof Error && error.message !== 'RESULT_SAVE_FAILED' &&
          active.has(currentMeta.state)) {
        currentMeta.state = currentMeta.requestId ? 'paused' : 'draft';
        await commit(currentMeta).catch(() => undefined);
      }
      if (error instanceof Error && error.message === 'RESULT_SAVE_FAILED')
        setError(t.saveDownload);
      else if (!abort.signal.aborted) fail(error);
      else if (abort.signal.reason?.message !== 'AUTH_REQUIRED' && abort.signal.reason?.message !== 'BACKGROUND_PAUSED' &&
               abort.signal.reason?.message !== 'USER_PAUSED') setError(t.network);
    } finally {
      verification.current?.reject(Error('NETWORK_ERROR'));
      setCheck(undefined);
      running.current = false;
      setBusy(false);
      controller.current = undefined;
      resumePending.current();
    }
  }
  async function again(meta: RecordMeta) {
    if (meta.mode !== 'classic' || meta.state !== 'failed') return;
    if (!meta.requestId) {
      await run([meta]);
      return;
    }
    if (!confirm(t.confirmAgain)) return;
    try {
      const data = await readImages(meta.id);
      if (!data) return;
      const id = crypto.randomUUID(),
        copy = {
          ...meta,
          id,
          created: Date.now(),
          updated: Date.now(),
          state: 'submitting',
          requestId: crypto.randomUUID(),
          intent: { retry_of: meta.requestId },
          snapshot: undefined,
          error: undefined,
        };
      const next = { ...data, id, result: undefined };
      copy.bytes = blobBytes(next);
      await commit(copy, next);
      await run([copy]);
    } catch (error) {
      fail(error);
    }
  }
  async function readResult(meta: RecordMeta) {
    const blob = volatile?.id === meta.id ? volatile.blob : (await readImages(meta.id))?.result;
    if (!blob) throw Error('INPUT_MISSING');
    return { blob, name: translationFilename(meta.name, meta.language, blob.type) };
  }
  async function download(records: RecordMeta[], archive = false) {
    if (!records.length || exporting.current || removing.current) return;
    exporting.current = true;
    setDownloading(true);
    setError('');
    try {
      if (archive) saveDownload(await translationArchive(records, readResult), 'node-comics-translations.zip');
      else {
        const { blob, name } = await readResult(records[0]);
        saveDownload(blob, name);
      }
    } catch (error) {
      fail(error);
    } finally {
      exporting.current = false;
      setDownloading(false);
    }
  }
  const entitlement = caps?.entitlements?.modes.classic;
  const displayed = rows.filter(
    (row) =>
      row.scope.startsWith('draft:') ||
      (isGuestScope
        ? row.scope.startsWith('guest:')
        : row.scope === 'user:' + account?.id),
  );
  const completed = displayed.filter((row) => row.state === 'succeeded' || row.id === volatile?.id);
  async function clearCache() {
    if (running.current || exporting.current || removing.current || importing || !displayed.length) return;
    if (!confirm(cacheCopy.confirm)) return;
    removing.current = true;
    setClearing(true);
    setError('');
    setCacheNotice('');
    resumeOnReturn.current = false;
    runningIds.current = [];
    try {
      await removeRecords(displayed.map(row => row.id));
      setVolatile(undefined);
      await refresh();
      setHasGuestHistory((await listRecords(['guest:*'])).length > 0);
      setCacheNotice(cacheCopy.cleared);
    } catch (error) {
      fail(error);
    } finally {
      removing.current = false;
      setClearing(false);
    }
  }
  return (
    <section className="translation-workbench container" data-has-images={!!displayed.length}>
      <header className="translation-heading">
        <div className="translation-heading-copy">
          <h1>{t.title}</h1>
          <p>{t.intro}</p>
        </div>
        <div className="translation-identity">
          <strong>{isGuestScope ? t.guest : account?.name || t.account}</strong>
          <div className="translation-quota" aria-live="polite">
            <span>{isGuestScope ? t.remaining : t.account}</span>
            <b>{isGuestScope ? (guest?.remaining ?? '—') : entitlement?.unlimited ? '∞' : (entitlement?.quota?.available ?? '—')}</b>
            <span>{isGuestScope ? `/ ${guest?.daily_limit ?? 5}` : entitlement?.unlimited ? t.unlimited : t.classic}</span>
          </div>
          {!account && (
            <button
              className="button secondary"
              onClick={() =>
                void signIn(localPath('/translate/', locale)).catch(fail)
              }
            >
              {t.login}
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="translation-alert" role="alert">
          <span className="translation-alert-mark" aria-hidden="true">!</span>
          <div><strong>{t.errorTitle}</strong><p>{error}</p></div>
          {!ready && <button className="button secondary" onClick={() => location.reload()}>{t.reload}</button>}
        </div>
      )}
      {isGuestScope && guest && !guest.enabled && (
        <p className="translation-availability">{t.disabled}</p>
      )}
      <section className="translation-composer" aria-label={t.uploadTitle}>
        <ImageDropzone
          copy={t}
          locale={locale}
          compact={!!displayed.length}
          disabled={busy || clearing || !ready}
          onAdded={refresh}
          onBusyChange={(value) => { setImporting(value); if (value) setCacheNotice(''); }}
        />
        <div className="translation-settings">
        <label>
          {t.language}
          <select
            value={language}
            disabled={busy}
            onChange={(event) => setLanguage(event.target.value)}
          >
            {languages.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          disabled={
            !ready ||
            clearing || importing ||
            busy ||
            !language ||
            (isGuestScope && !guest?.enabled) ||
            !displayed.some(
              (row) => row.state === 'draft' || row.state === 'preparing',
            )
          }
          onClick={() =>
            void run(
              displayed.filter(
                (row) =>
                  !row.requestId &&
                  (row.state === 'draft' || row.state === 'preparing'),
              ),
            )
          }
        >
          {busy ? t.busy : t.start}
          <span className="ui-icon icon-arrow" aria-hidden="true" />
        </button>
        {busy && (
          <button
            className="button secondary"
            onClick={pause}
          >
            {t.cancel}
          </button>
        )}
        </div>
      </section>
      {check && (
        <div className="translation-verification-overlay">
          <div ref={verificationDialog} className="translation-verification"
            role="dialog" aria-modal="true" aria-label={t.verify}
            onKeyDown={(event) => { if (event.key === 'Escape') pause(); }}>
            <div className="translation-verification-copy"><strong>{t.verify}</strong><p>{t.verificationHint}</p></div>
            <Turnstile
              key={check.id}
              siteKey={guest!.site_key}
              action={check.action}
              onToken={(token) => verification.current?.resolve(token)}
              onError={() =>
                verification.current?.reject(Error('VERIFICATION_FAILED'))
              }
            />
            <button className="translation-verification-close" aria-label={t.cancel} onClick={pause}><span aria-hidden="true">×</span></button>
          </div>
        </div>
      )}
      <section className="translation-files" aria-label={t.files}>
        <div className="translation-files-heading">
          <h2>{t.files} <span className="translation-history-count">{displayed.length}</span></h2>
          <div className="translation-file-actions">
          <button className="button secondary" data-download-all disabled={downloading || clearing || !completed.length}
            onClick={() => void download(completed, true)}>
            {downloading ? t.busy : t.downloadAll}
          </button>
          <button className="button secondary" data-clear-cache disabled={busy || downloading || importing || clearing || !displayed.length}
            onClick={() => void clearCache()}>{clearing ? t.busy : cacheCopy.clear}</button>
          </div>
        </div>
          {cacheNotice && <p role="status" className="translation-cache-notice">{cacheNotice}</p>}
          {account && (hasGuestHistory || showGuest) && (
            <div className="translation-tabs" role="group" aria-label={t.history}>
              <button
                disabled={busy || downloading || importing || clearing}
                aria-pressed={!showGuest}
                onClick={() => void changeHistory(false).catch(fail)}
              >
                {t.myHistory}
              </button>
              <button
                disabled={busy || downloading || importing || clearing}
                aria-pressed={showGuest}
                onClick={() => void changeHistory(true).catch(fail)}
              >
                {t.guestHistory}
              </button>
            </div>
          )}
          {!!displayed.length && (
            <div className="translation-progress">
              <span role="status">{t.succeeded} {completed.length} / {displayed.length}</span>
              <progress max={displayed.length} value={completed.length} aria-label={t.succeeded} />
            </div>
          )}
          <ol className="translation-records">
            {displayed.map((row, index) => (
              <li key={row.id} data-state={row.state}>
                  <span className="record-number">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="record-copy">
                    <strong title={row.name}>{row.name}</strong>
                    <small>
                      <span className="record-state" data-state={row.state}>{t[row.state as keyof typeof t] ?? t.paused}</span>
                      {row.state !== 'draft' && <span>{row.language}</span>}
                      {row.snapshot?.result?.kind === 'no_text' && <span>{t.noText}</span>}
                      {row.snapshot?.result?.kind === 'partial' && <span>{t.partial}</span>}
                    </small>
                    {row.error && <p className="translation-error">{translationError(row.error, t)}</p>}
                  </div>
                  <div className="record-actions">
                    {(row.state === 'succeeded' || volatile?.id === row.id) && (
                      <button className="button secondary" disabled={downloading || clearing} onClick={() => void download([row])}>{t.download}</button>
                    )}
                    {row.requestId && !['failed', 'succeeded'].includes(row.state) && (
                      <button className="button secondary" disabled={busy || importing || clearing} onClick={() => void run([row])}>{t.resume}</button>
                    )}
                    {row.mode === 'classic' && row.state === 'failed' && (
                      <button className="button secondary" disabled={busy || importing || clearing} onClick={() => void again(row)}>{t.retry}</button>
                    )}
                    <button className="text-link" disabled={busy || downloading || importing || clearing} onClick={() => {
                      if (confirm(t.confirmDelete)) void removeRecord(row.id).then(refresh).catch(fail);
                    }}>{t.remove}</button>
                  </div>
              </li>
            ))}
          </ol>
          {!displayed.length && <p className="translation-history-empty">{t.historyEmpty}</p>}
      </section>
      <details className="translation-notes translation-details">
        <summary>{t.localTitle} · {t.serverTitle}</summary>
        <div className="translation-notes-body">
          <div><strong>{t.localTitle}</strong><p>{t.local}</p></div>
          <div><strong>{t.serverTitle}</strong><p>{t.retention}</p></div>
        </div>
        <div className="translation-storage">
          <p><span>{t.storage}</span><strong>{(usedBytes / 1024 / 1024).toFixed(1)} / 256 MiB</strong></p>
          <meter min={0} max={256 * 1024 * 1024} value={usedBytes} aria-label={t.storage} />
        </div>
      </details>
    </section>
  );
}
