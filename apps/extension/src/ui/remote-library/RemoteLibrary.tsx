import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { msg } from '../../i18n/runtime';
import { Icon } from '../../icons';
import { RequestPool } from '../../concurrency';
import type {
  SourceAccount,
  RemoteCatalogPage,
  RemotePublication,
  RemoteReadingPlan,
} from '../../comics/sources/contracts';
import {
  browseRemoteLibrary,
  listRemoteLibraries,
  openRemotePublication,
  readRemoteArtwork,
} from '../../comics/application/remote-library-service';
import { subscribeSourceAccounts } from '../../comics/application/source-service';
import { disconnectSource } from '../../comics/application/source-lifecycle';
import { Modal } from '../components';
import { ConnectionDialog } from './ConnectionDialog';
import './remote-library.css';

const artworkPool = new RequestPool(2);
type Location = {
  location?: string;
  cursor?: string;
  search?: string;
  title?: string;
  scrollTop: number;
};
type Props = {
  active: boolean;
  onRead: (entryId: string, isCurrent: () => boolean) => Promise<void> | void;
  onDownload: (connectionId: string, plan: RemoteReadingPlan) => void;
};

/** One remote page at a time. Browsing never creates Comic/Entry records or fetches body pages. */
export function RemoteLibrary({ active, onRead, onDownload }: Props) {
  const [accounts, setAccounts] = useState<SourceAccount[]>([]),
    [accountId, setAccountId] = useState('');
  const [listError, setListError] = useState(''),
    [loaded, setLoaded] = useState(false),
    [page, setPage] = useState<RemoteCatalogPage>();
  const [location, setLocation] = useState<Location>({ scrollTop: 0 }),
    [history, setHistory] = useState<Location[]>([]);
  const [search, setSearch] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [opening, setOpening] = useState<string>();
  const [editing, setEditing] = useState<SourceAccount | null | undefined>(),
    [disconnecting, setDisconnecting] = useState<SourceAccount>();
  const [refresh, setRefresh] = useState(0),
    [actionError, setActionError] = useState('');
  const account = accounts.find((value) => value.id === accountId),
    blocked = !!account && ['disconnected', 'revoked', 'reauth-required'].includes(account.status);
  const current = useRef({ active, accountId });
  current.current = { active, accountId };
  const listEpoch = useRef(0),
    openRequest = useRef<AbortController | undefined>(undefined),
    pageRequest = useRef<AbortController | undefined>(undefined);
  const savedScroll = useRef(0),
    restoreScroll = useRef(false);
  const completedPage = useRef<string|undefined>(undefined);
  const reloadAccounts = useCallback(async () => {
    const epoch = ++listEpoch.current;
    try {
      const result = await listRemoteLibraries();
      if (epoch !== listEpoch.current) return;
      setAccounts(result.connections);
      setListError(result.errors.map((item) => `${item.providerLabel}: ${item.error}`).join('\n'));
      setAccountId((previous) =>
        result.connections.some((item) => item.id === previous)
          ? previous
          : (result.connections[0]?.id ?? ''),
      );
    } catch (error) {
      if (epoch === listEpoch.current) setListError((error as Error).message);
    } finally {
      if (epoch === listEpoch.current) setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void reloadAccounts();
    const stop = subscribeSourceAccounts(() => void reloadAccounts());
    return () => {
      listEpoch.current++;
      stop();
    };
  }, [reloadAccounts]);
  useEffect(() => {
    if (!accountId || blocked) {
      completedPage.current = undefined;
      setPage(undefined);
      setBusy(false);
      return;
    }
    if (!active) return;
    const pageKey = JSON.stringify([accountId, location, refresh]);
    if (completedPage.current === pageKey) return;
    const controller = new AbortController();
    pageRequest.current = controller;
    setBusy(true);
    setError('');
    void browseRemoteLibrary(accountId, { ...location, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        completedPage.current = pageKey;
        setPage(result);
        restoreScroll.current = true;
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError((error as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [accountId, location, refresh, blocked, active]);
  useLayoutEffect(() => {
    if (active && restoreScroll.current) {
      restoreScroll.current = false;
      window.scrollTo({ top: location.scrollTop, behavior: 'instant' });
    }
  }, [page, active, location]);
  useLayoutEffect(() => {
    if (active) window.scrollTo({ top: savedScroll.current, behavior: 'instant' });
  }, [active]);
  useEffect(() => {
    if (!active) {
      openRequest.current?.abort();
      openRequest.current = undefined;
      setOpening(undefined);
      return;
    }
    const save = () => {
      savedScroll.current = window.scrollY;
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, [active]);
  useEffect(
    () => () => {
      openRequest.current?.abort();
      pageRequest.current?.abort();
    },
    [],
  );
  function reset(id: string) {
    cancelOpening();
    completedPage.current = undefined;
    setAccountId(id);
    setPage(undefined);
    setHistory([]);
    setSearch('');
    setError('');
    setActionError('');
    savedScroll.current = 0;
    setLocation({ scrollTop: 0 });
  }
  function cancelOpening() {
    openRequest.current?.abort();
    openRequest.current = undefined;
    setOpening(undefined);
  }
  function navigate(next: Location) {
    cancelOpening();
    setHistory((previous) =>
      [...previous, { ...location, title: page?.title, scrollTop: window.scrollY }].slice(-32),
    );
    setPage(undefined);
    savedScroll.current = next.scrollTop;
    setLocation(next);
    setError('');
    setActionError('');
  }
  function back() {
    const previous = history.at(-1);
    if (!previous) return;
    cancelOpening();
    setHistory((value) => value.slice(0, -1));
    setPage(undefined);
    savedScroll.current = previous.scrollTop;
    setLocation(previous);
    setSearch(previous.search ?? '');
    setActionError('');
  }
  async function read(publication: RemotePublication) {
    if (!accountId || openRequest.current) return;
    const controller = new AbortController();
    openRequest.current = controller;
    setOpening(publication.id);
    setActionError('');
    const isCurrent = () =>
      !controller.signal.aborted &&
      current.current.active &&
      current.current.accountId === accountId;
    try {
      const result = await openRemotePublication(accountId, publication.id, controller.signal);
      if (!isCurrent()) return;
      if (result.kind === 'download-required') onDownload(accountId, result.plan);
      else {
        savedScroll.current = window.scrollY;
        await onRead(result.entryId, isCurrent);
      }
    } catch (error) {
      if (isCurrent()) setActionError((error as Error).message);
    } finally {
      if (openRequest.current === controller) {
        openRequest.current = undefined;
        setOpening(undefined);
      }
    }
  }
  const publications = page?.publications ?? [];
  return (
    <section className="nc-remote-library" aria-label={msg('远程书库')}>
      <div className="nc-page-heading">
        <div>
          <h1>{msg('远程书库')}</h1>
          <p>{msg('连接书库即可浏览，点开漫画直接阅读。')}</p>
        </div>
        <button className="button primary" onClick={() => setEditing(null)}>
          <Icon name="plus" />
          {msg('连接书库')}
        </button>
      </div>
      {listError && (
        <div role="alert" className="nc-remote-error">
          <p>{listError}</p>
          <button className="button secondary small" onClick={() => void reloadAccounts()}>
            {msg('重试')}
          </button>
        </div>
      )}
      {!loaded ? (
        <p role="status">{msg('正在读取书库…')}</p>
      ) : !accounts.length ? (
        <div className="nc-empty">
          <Icon name="cloud" size={48} />
          <h2>{msg('连接远程书库')}</h2>
          <p>{msg('填写服务地址，按需授权。无需导入整个目录。')}</p>
          <button className="button primary" onClick={() => setEditing(null)}>
            {msg('连接书库')}
          </button>
        </div>
      ) : (
        <>
          <div className="nc-remote-connections" aria-label={msg('已连接的书库')}>
            {accounts.map((item) => (
              <button
                key={item.id}
                className={'button ' + (item.id === accountId ? 'primary' : 'secondary')}
                aria-pressed={item.id === accountId}
                onClick={() => reset(item.id)}
              >
                <Icon name="cloud" size={18} />
                {item.displayName}
              </button>
            ))}
          </div>
          {account && (
            <div className="nc-remote-toolbar">
              <div className="nc-inline">
                <button
                  className="button secondary small"
                  disabled={!history.length || busy}
                  onClick={back}
                >
                  <Icon name="arrow" style={{ transform: 'rotate(180deg)' }} size={16} />
                  {msg('返回上级')}
                </button>
                <button className="text-link" disabled={busy} onClick={() => reset(accountId)}>
                  {msg('书库首页')}
                </button>
                {page && <span className="nc-muted">{page.title}</span>}
              </div>
              <div className="nc-inline">
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => {
                    setLocation((value) => ({ ...value, scrollTop: window.scrollY }));
                    setRefresh((value) => value + 1);
                  }}
                >
                  {msg('刷新')}
                </button>
                <button className="text-link" onClick={() => setEditing(account)}>
                  {msg('重新连接')}
                </button>
                {account.status !== 'disconnected' && (
                  <button className="text-link" onClick={() => setDisconnecting(account)}>
                    {msg('断开连接')}
                  </button>
                )}
              </div>
            </div>
          )}
          {blocked ? (
            <p role="status">{msg('书库需要重新连接，请更新授权后继续。')}</p>
          ) : (
            <>
              {page?.searchable && (
                <form
                  className="nc-remote-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (search.trim())
                      navigate({ location: page.location, search: search.trim(), scrollTop: 0 });
                  }}
                >
                  <label className="nc-search">
                    <Icon name="search" size={18} />
                    <input
                      type="search"
                      aria-label={msg('搜索书库')}
                      placeholder={msg('搜索书库')}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      maxLength={256}
                    />
                  </label>
                  <button className="button secondary" disabled={busy || !search.trim()}>
                    {msg('搜索')}
                  </button>
                </form>
              )}
              {busy && (
                <p role="status" className="nc-remote-status">
                  <span className="spinner" />
                  {msg('正在读取书库…')}
                </p>
              )}
              {error && (
                <div role="alert" className="nc-remote-error">
                  <p>{error}</p>
                  <button
                    className="button secondary small"
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    {msg('重试')}
                  </button>
                </div>
              )}
              {actionError && (
                <p role="alert" className="nc-remote-error">
                  {actionError}
                </p>
              )}
              {!!page?.navigation.length && (
                <nav className="nc-remote-navigation" aria-label={msg('书库目录')}>
                  {page.navigation.map((item) => (
                    <button
                      key={item.id}
                      className="button secondary"
                      disabled={busy}
                      onClick={() => navigate({ location: item.location, scrollTop: 0 })}
                    >
                      {item.title}
                      <Icon name="arrow" size={16} />
                    </button>
                  ))}
                </nav>
              )}
              {!!page?.facets?.length && (
                <div className="nc-remote-facets">
                  {page.facets.map((facet, index) => (
                    <details key={index}>
                      <summary>{facet.title}</summary>
                      <div className="nc-remote-navigation">
                        {facet.links.map((link) => (
                          <button
                            key={link.id}
                            className={'button small ' + (link.active ? 'primary' : 'secondary')}
                            disabled={busy || link.active}
                            onClick={() => navigate({ location: link.location, scrollTop: 0 })}
                          >
                            {link.title}
                          </button>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              )}
              {page &&
                !busy &&
                !publications.length &&
                !page.navigation.length &&
                !page.groups?.length && (
                  <p className="nc-empty">{msg('此目录暂无可显示的内容。')}</p>
                )}
              {!!publications.length && (
                <div className="nc-remote-grid">
                  {publications.map((publication) => (
                    <PublicationCard
                      key={publication.id}
                      active={active && !blocked}
                      connectionId={accountId}
                      publication={publication}
                      busy={!!opening}
                      onRead={() => void read(publication)}
                    />
                  ))}
                </div>
              )}
              {page?.groups?.map((group, index) => (
                <section className="nc-remote-group" key={index}>
                  <h2>{group.title}</h2>
                  {!!group.navigation.length && (
                    <nav className="nc-remote-navigation">
                      {group.navigation.map((item) => (
                        <button
                          key={item.id}
                          className="button secondary"
                          disabled={busy}
                          onClick={() => navigate({ location: item.location, scrollTop: 0 })}
                        >
                          {item.title}
                          <Icon name="arrow" size={16} />
                        </button>
                      ))}
                    </nav>
                  )}
                  <div className="nc-remote-grid">
                    {group.publications.map((publication) => (
                      <PublicationCard
                        key={publication.id}
                        active={active && !blocked}
                        connectionId={accountId}
                        publication={publication}
                        busy={!!opening}
                        onRead={() => void read(publication)}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {(page?.next || page?.previous) && (
                <div className="nc-remote-pagination">
                  {page.previous && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        navigate({
                          location: page.location,
                          cursor: page.previous,
                          search: location.search,
                          scrollTop: 0,
                        })
                      }
                    >
                      {msg('上一页')}
                    </button>
                  )}
                  {page.next && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        navigate({
                          location: page.location,
                          cursor: page.next,
                          search: location.search,
                          scrollTop: 0,
                        })
                      }
                    >
                      {msg('下一页')}
                      <Icon name="arrow" size={18} />
                    </button>
                  )}
                </div>
              )}
              {opening && (
                <div className="busy-pill" role="status">
                  <span className="spinner" />
                  {msg('正在打开漫画')}
                  <button className="text-link" onClick={cancelOpening}>
                    {msg('取消')}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
      {editing !== undefined && (
        <ConnectionDialog
          account={editing ?? undefined}
          onClose={() => setEditing(undefined)}
          onConnected={(connection) => {
            setEditing(undefined);
            void reloadAccounts().then(() => reset(connection.id));
          }}
        />
      )}
      {disconnecting && (
        <Modal title={msg('断开连接')} onClose={() => setDisconnecting(undefined)}>
          <p>
            {msg('断开《{0}》后将停止来源请求；漫画与阅读记录保留，重新授权后可继续。', {
              '0': disconnecting.displayName,
            })}
          </p>
          <div className="nc-inline">
            <button
              className="button danger"
              onClick={() => {
                const item = disconnecting;
                setDisconnecting(undefined);
                void disconnectSource(item.id)
                  .then(reloadAccounts)
                  .catch((error) => setActionError(error.message));
              }}
            >
              {msg('断开连接')}
            </button>
            <button className="button secondary" onClick={() => setDisconnecting(undefined)}>
              {msg('取消')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function PublicationCard({
  active,
  connectionId,
  publication,
  busy,
  onRead,
}: {
  active: boolean;
  connectionId: string;
  publication: RemotePublication;
  busy: boolean;
  onRead: () => void;
}) {
  const ref = useRef<HTMLElement>(null),
    [visible, setVisible] = useState(false),
    [url, setUrl] = useState<string>();
  useEffect(() => {
    const element = ref.current;
    if (!element || !active) {
      setVisible(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '240px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (!active || !visible || !publication.artwork) {
      setUrl(undefined);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl(undefined);
    void artworkPool
      .run(async () => {
        controller.signal.throwIfAborted();
        const blob = await readRemoteArtwork(connectionId, publication.artwork!, controller.signal);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        /* Cover failure must not prevent browsing or opening. */
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active, visible, connectionId, publication.artwork]);
  return (
    <article ref={ref} className="nc-remote-publication" data-publication-id={publication.id}>
      <button
        className="nc-remote-cover"
        disabled={busy || publication.readable === false}
        onClick={onRead}
        aria-label={msg('打开漫画 {0}', { '0': publication.title })}
      >
        {url ? <img src={url} alt="" loading="lazy" /> : <Icon name="book" size={48} />}
      </button>
      <div className="nc-remote-publication-info">
        <h2>
          <button disabled={busy || publication.readable === false} onClick={onRead}>
            {publication.title}
          </button>
        </h2>
        {!!publication.authors?.length && (
          <p className="nc-muted">{publication.authors.join(' · ')}</p>
        )}
        {!!publication.formats?.length && (
          <p className="nc-remote-formats">{publication.formats.join(' · ')}</p>
        )}
        {publication.reason && <p className="nc-muted">{publication.reason}</p>}
      </div>
    </article>
  );
}
