import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ImageDropzone from './ImageDropzone';
import Turnstile from './Turnstile';
import { translationCopy, translationError } from '../i18n/translate';
import { localPath, type Locale } from '../i18n';
import { signIn } from '../lib/auth';
import {
  blobBytes,
  draftScope,
  listRecords,
  localSnapshotState,
  readImages,
  removeRecord,
  saveRecord,
  storageBytes,
  type RecordMeta,
  type Mode,
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
import '../styles/translate.css';

const active = new Set([
  'needs_input',
  'queued',
  'running',
  'preparing',
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

function Preview({
  record,
  view,
  zoom,
  volatile,
}: {
  record?: RecordMeta;
  view: string;
  zoom: number;
  volatile?: Blob;
}) {
  const [urls, setUrls] = useState<{ original: string; result?: string }>();
  const viewport = useRef<HTMLDivElement>(null),
    position = useRef({ top: 0, left: 0 });
  useEffect(() => {
    let gone = false;
    const made: string[] = [];
    if (record)
      void readImages(record.id).then((data) => {
        if (gone || !data) return;
        const original = URL.createObjectURL(data.source),
          translated = volatile ?? data.result,
          result = translated ? URL.createObjectURL(translated) : undefined;
        made.push(original, ...(result ? [result] : []));
        setUrls({ original, result });
      });
    return () => {
      gone = true;
      made.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [record?.id, record?.bytes, volatile]);
  function restore() {
    const element = viewport.current;
    if (element) {
      element.scrollTop =
        position.current.top *
        Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollLeft =
        position.current.left *
        Math.max(0, element.scrollWidth - element.clientWidth);
    }
  }
  useLayoutEffect(restore, [view, urls, zoom]);
  return (
    <div
      ref={viewport}
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        position.current = {
          top:
            element.scrollHeight > element.clientHeight
              ? element.scrollTop /
                (element.scrollHeight - element.clientHeight)
              : position.current.top,
          left:
            element.scrollWidth > element.clientWidth
              ? element.scrollLeft / (element.scrollWidth - element.clientWidth)
              : position.current.left,
        };
      }}
      className="translation-canvas"
      data-compare={view === 'compare'}
    >
      {urls && (
        <div className="translation-images" style={{ width: zoom + '%' }}>
          {(view !== 'translated' || !urls.result) && (
            <img
              src={urls.original}
              width={record?.width}
              height={record?.height}
              onLoad={restore}
              alt={record?.name ?? ''}
            />
          )}
          {view !== 'original' && urls.result && (
            <img
              src={urls.result}
              width={record?.width}
              height={record?.height}
              onLoad={restore}
              alt={record?.name ?? ''}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default function TranslationWorkbench({ locale }: { locale: Locale }) {
  const t = translationCopy[locale];
  const [rows, setRows] = useState<RecordMeta[]>([]),
    [selected, setSelected] = useState(''),
    [account, setAccount] = useState<Account>(),
    [guest, setGuest] = useState<Guest>(),
    [caps, setCaps] = useState<Capabilities>(),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [view, setView] = useState('translated'),
    [zoom, setZoom] = useState(100),
    [mode, setMode] = useState<Mode>('classic'),
    [language, setLanguage] = useState(
      locale === 'zh-CN' ? 'zh-Hans' : locale === 'zh-TW' ? 'zh-Hant' : locale,
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
  const guestRef = useRef<Guest | undefined>(undefined);
  const scopes = useRef<string[]>([]);
  const [hasGuestHistory, setHasGuestHistory] = useState(false);
  const [usedBytes, setUsedBytes] = useState(0);
  const current = rows.find((row) => row.id === selected) ?? rows[0];
  const isGuestScope = showGuest || !account;
  const languages =
    caps?.languages.filter((item) =>
      caps.modes.find((item) => item.id === mode)?.languages.includes(item.id),
    ) ?? [];
  useEffect(() => {
    if (caps && !languages.some((item) => item.id === language))
      setLanguage(languages[0]?.id ?? '');
  }, [caps, mode]);
  async function refresh() {
    const [found, used] = await Promise.all([
      listRecords(scopes.current),
      storageBytes(),
    ]);
    setRows(found);
    setUsedBytes(used);
    setSelected((id) =>
      found.some((row) => row.id === id) ? id : (found[0]?.id ?? ''),
    );
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
    setRows((old) =>
      [...old.filter((row) => row.id !== meta.id), { ...meta }].sort(
        (a, b) => b.created - a.created,
      ),
    );
  }
  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const identity = await currentAccount();
        if (gone) return;
        setAccount(identity);
        scopes.current = [
          draftScope(),
          identity ? 'user:' + identity.id : 'guest:*',
        ];
        await refresh();
        setHasGuestHistory((await listRecords(['guest:*'])).length > 0);
        const [visitor, capabilities] = await Promise.all([
          json<Guest>('/v1/guest/session'),
          json<Capabilities>('/v1/capabilities', {}, identity),
        ]);
        if (gone) return;
        if (capabilities.result_protocol !== 'overlay-v1')
          throw Error('CLIENT_UPGRADE_REQUIRED');
        setGuest(visitor);
        guestRef.current = visitor;
        setCaps(capabilities);
        if (!gone) setReady(true);
      } catch (error) {
        if (!gone) fail(error);
      }
    })();
    return () => {
      gone = true;
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
  useEffect(() => {
    function stop() {
      if (document.hidden || !navigator.onLine) {
        controller.current?.abort();
        verification.current?.reject(Error('NETWORK_ERROR'));
        setCheck(undefined);
      }
    }
    document.addEventListener('visibilitychange', stop);
    window.addEventListener('offline', stop);
    return () => {
      document.removeEventListener('visibilitychange', stop);
      window.removeEventListener('offline', stop);
    };
  }, []);
  async function changeHistory(value: boolean) {
    setShowGuest(value);
    if (value) setMode('classic');
    scopes.current = [
      draftScope(),
      ...(value || !account ? ['guest:*'] : ['user:' + account.id]),
    ];
    await refresh();
  }
  function challenge(action: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(Error('NETWORK_ERROR'));
        return;
      }
      const finish = (token?: string, error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        verification.current = undefined;
        setCheck(undefined);
        error ? reject(error) : resolve(token!);
      };
      const cancel = () => finish(undefined, Error('NETWORK_ERROR'));
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
    if (running.current || !caps || !ready) return;
    running.current = true;
    setBusy(true);
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    try {
      for (const stored of candidates) {
        abort.signal.throwIfAborted();
        const meta = { ...stored };
        setSelected(meta.id);
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
          meta.mode = useAccount ? mode : 'classic';
          meta.language = language;
        }
        if (!data.input) {
          meta.state = 'preparing';
          meta.error = undefined;
          await commit(meta);
          let prepared;
          try {
            prepared = await pixels(data.source, caps.limits);
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
        meta.state = 'paused';
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
                },
              ),
              signal: abort.signal,
            },
            useAccount,
          );
        }
        const receive = async (value: Snapshot) => {
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
          try {
            await watch(
              path,
              meta.requestId,
              useAccount,
              abort.signal,
              receive,
            );
            failures = 0;
          } catch (error) {
            if (abort.signal.aborted) throw error;
            if (
              error instanceof TranslationError &&
              (error.status === 401 ||
                error.status === 403 ||
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
          if (['queued', 'running'].includes(snapshot.state))
            await delay(1000, abort.signal);
        }
        if (snapshot?.state === 'succeeded' && snapshot.result) {
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
            setVolatile(undefined);
          } catch {
            setVolatile({ id: meta.id, blob: output });
            throw Error('RESULT_SAVE_FAILED');
          }
        }
        if (!useAccount) {
          guestRef.current = await json<Guest>('/v1/guest/session');
          setGuest(guestRef.current);
        } else
          setCaps(await json<Capabilities>('/v1/capabilities', {}, useAccount));
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'RESULT_SAVE_FAILED')
        setError(t.saveDownload);
      else if (!abort.signal.aborted) fail(error);
      else setError(t.network);
    } finally {
      verification.current?.reject(Error('NETWORK_ERROR'));
      setCheck(undefined);
      running.current = false;
      setBusy(false);
      controller.current = undefined;
    }
  }
  async function again(meta: RecordMeta) {
    if (!['failed', 'succeeded'].includes(meta.state)) return;
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
          state: 'paused',
          requestId: crypto.randomUUID(),
          intent:
            meta.state === 'failed'
              ? { retry_of: meta.requestId }
              : { regenerate_of: meta.requestId },
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
  async function download() {
    if (!current) return;
    try {
      const blob =
        volatile?.id === current.id
          ? volatile.blob
          : (await readImages(current.id))?.result;
      if (!blob) throw Error('NETWORK_ERROR');
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download =
        current.name.replace(/\.[^.]+$/, '') +
        '-' +
        current.language +
        (blob.type === 'image/webp'
          ? '.webp'
          : blob.type === 'image/jpeg'
            ? '.jpg'
            : '.png');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      fail(error);
    }
  }
  const entitlement = caps?.entitlements?.modes[mode];
  const displayed = rows.filter(
    (row) =>
      row.scope.startsWith('draft:') ||
      (isGuestScope
        ? row.scope.startsWith('guest:')
        : row.scope === 'user:' + account?.id),
  );
  return (
    <section className="translation-workbench container">
      <header className="translation-heading">
        <div>
          <p className="eyebrow">NODELANE / TRANSLATE</p>
          <h1>{t.title}</h1>
          <p>{t.intro}</p>
        </div>
        <div className="translation-identity">
          <strong>{isGuestScope ? t.guest : account?.name}</strong>
          <span>
            {!isGuestScope
              ? `${t.account} · ${entitlement?.unlimited ? t.unlimited : (entitlement?.quota?.available ?? '—')}`
              : `${t.remaining} · ${guest?.remaining ?? '—'} / ${guest?.daily_limit ?? 5}`}
          </span>
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
        <p className="translation-error" role="alert">
          {error}
        </p>
      )}
      {isGuestScope && guest && !guest.enabled && (
        <p className="translation-note">{t.disabled}</p>
      )}
      <div className="translation-toolbar">
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
        <label>
          {t.mode}
          <select
            value={mode}
            disabled={busy || isGuestScope}
            onChange={(event) => setMode(event.target.value as Mode)}
          >
            <option value="classic">{t.classic}</option>
            <option
              value="redraw"
              disabled={
                !caps?.modes.find((item) => item.id === 'redraw')?.enabled ||
                !caps?.entitlements?.modes.redraw?.allowed
              }
            >
              {t.redraw}
            </option>
          </select>
        </label>
        <button
          className="button"
          disabled={
            !ready ||
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
        </button>
        {busy && (
          <button
            className="button secondary"
            onClick={() => {
              controller.current?.abort();
            }}
          >
            {t.cancel}
          </button>
        )}
      </div>
      {check && (
        <div className="translation-verification">
          <p>{t.verify}</p>
          <Turnstile
            key={check.id}
            siteKey={guest!.site_key}
            action={check.action}
            onToken={(token) => verification.current?.resolve(token)}
            onError={() =>
              verification.current?.reject(Error('VERIFICATION_FAILED'))
            }
          />
        </div>
      )}
      <div className="translation-layout">
        <aside className="translation-sidebar">
          <h2>{t.history}</h2>
          {account && hasGuestHistory && (
            <div className="translation-tabs">
              <button
                disabled={busy}
                aria-pressed={!showGuest}
                onClick={() => void changeHistory(false).catch(fail)}
              >
                {t.myHistory}
              </button>
              <button
                disabled={busy}
                aria-pressed={showGuest}
                onClick={() => void changeHistory(true).catch(fail)}
              >
                {t.guestHistory}
              </button>
            </div>
          )}
          <ImageDropzone
            locale={locale}
            disabled={busy || !ready}
            onAdded={refresh}
          />
          <ol className="translation-records">
            {displayed.map((row, index) => (
              <li key={row.id}>
                <button
                  aria-current={current?.id === row.id ? 'true' : undefined}
                  onClick={() => {
                    setSelected(row.id);
                    setZoom(100);
                    setVolatile((value) =>
                      value?.id === row.id ? value : undefined,
                    );
                  }}
                >
                  <span className="record-number">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span>
                    <strong>{row.name}</strong>
                    <small>
                      {t[row.state as keyof typeof t] ?? t.paused} ·{' '}
                      {new Date(row.created).toLocaleDateString(locale)}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <p className="translation-storage">
            {t.storage}: {(usedBytes / 1024 / 1024).toFixed(1)} / 256 MiB
          </p>
        </aside>
        <div className="translation-viewer">
          <div className="translation-view-toolbar">
            <div className="translation-tabs">
              {(['original', 'translated', 'compare'] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={view === value}
                  onClick={() => setView(value)}
                >
                  {t[value]}
                </button>
              ))}
            </div>
            <label>
              {t.fit}
              <input
                aria-label={t.fit}
                type="range"
                min="50"
                max="200"
                step="10"
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              />
            </label>
          </div>
          {current ? (
            <Preview
              key={current.id}
              record={current}
              view={view}
              zoom={zoom}
              volatile={volatile?.id === current.id ? volatile.blob : undefined}
            />
          ) : (
            <div className="translation-empty">
              <span aria-hidden="true">＋</span>
              <p>{t.empty}</p>
            </div>
          )}
          {current && (
            <footer className="translation-result-actions">
              <div>
                <strong>
                  {current.width && `${current.width} × ${current.height}`}
                </strong>
                {current.snapshot?.result?.kind === 'no_text' && (
                  <span>{t.noText}</span>
                )}
                {current.snapshot?.result?.kind === 'partial' && (
                  <span>{t.partial}</span>
                )}
                {current.error && (
                  <p className="translation-error">
                    {translationError(current.error, t)}
                  </p>
                )}
              </div>
              <div>
                {(current.state === 'succeeded' ||
                  volatile?.id === current.id) && (
                  <button className="button" onClick={() => void download()}>
                    {t.download}
                  </button>
                )}
                {current.requestId &&
                  !['failed', 'succeeded'].includes(current.state) && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void run([current])}
                    >
                      {t.resume}
                    </button>
                  )}
                {['failed', 'succeeded'].includes(current.state) && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void again(current)}
                  >
                    {current.state === 'failed' ? t.retry : t.regenerate}
                  </button>
                )}
                <button
                  className="text-link"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t.confirmDelete))
                      void removeRecord(current.id).then(refresh).catch(fail);
                  }}
                >
                  {t.remove}
                </button>
              </div>
            </footer>
          )}
        </div>
      </div>
      <p className="translation-note">{t.local}</p>
      <p className="translation-note">{t.retention}</p>
    </section>
  );
}
