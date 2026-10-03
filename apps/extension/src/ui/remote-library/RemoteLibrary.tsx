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
import { connectionCapabilities, subscribeSourceAccounts } from '../../comics/application/source-service';
import { disconnectSource } from '../../comics/application/source-lifecycle';
import { Modal } from '../components';
import { useContextMenu } from '../ContextMenu';
import { ConnectionDialog } from './ConnectionDialog';
import { RemoveConnectionDialog } from './RemoveConnectionDialog';
import './remote-library.css';

const artworkPool = new RequestPool(2);
const fileSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : bytes >= 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${bytes} B`;
type Location = {
  location?: string;
  cursor?: string;
  search?: string;
  searchLocation?: string;
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
    [disconnecting, setDisconnecting] = useState<SourceAccount>(),
    [removing, setRemoving] = useState<SourceAccount>();
  const [refresh, setRefresh] = useState(0),
    [actionError, setActionError] = useState(''),
    [details, setDetails] = useState<RemotePublication>();
  const menu = useContextMenu(active);
  const account = accounts.find((value) => value.id === accountId),
    blocked = !!account && ['disconnected', 'revoked', 'reauth-required'].includes(account.status);
  const current = useRef({ active, accountId });
  current.current = { active, accountId };
  const listEpoch = useRef(0),
    openRequest = useRef<AbortController | undefined>(undefined),
    pageRequest = useRef<AbortController | undefined>(undefined);
  const savedScroll = useRef(0),
    restoreScroll = useRef(false),
    breadcrumbTrail = useRef<HTMLOListElement>(null);
  const completedPage = useRef<string | undefined>(undefined),
    catalogRoot = useRef<string | undefined>(undefined);
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
        catalogRoot.current = result.breadcrumbs?.[0]?.location;
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
      setDetails(undefined);
      return;
    }
    const save = () => {
      if (current.current.active) savedScroll.current = window.scrollY;
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
    catalogRoot.current = undefined;
    setAccountId(id);
    setPage(undefined);
    setHistory([]);
    setSearch('');
    setError('');
    setActionError('');
    setDetails(undefined);
    savedScroll.current = 0;
    setLocation({ scrollTop: 0 });
  }
  function cancelOpening() {
    openRequest.current?.abort();
    openRequest.current = undefined;
    setOpening(undefined);
  }
  function navigate(next: Location, replace = false) {
    cancelOpening();
    completedPage.current = undefined;
    if (!replace)
      setHistory((previous) =>
        [
          ...previous,
          {
            ...location,
            location: page?.location ?? location.location,
            title: page?.title ?? location.title,
            scrollTop: window.scrollY,
          },
        ].slice(-32),
      );
    setPage(undefined);
    savedScroll.current = next.scrollTop;
    setLocation(next);
    setError('');
    setActionError('');
    setSearch(next.search ?? '');
  }
  function back(index = history.length - 1) {
    const previous = history[index];
    if (!previous) return;
    cancelOpening();
    completedPage.current = undefined;
    setHistory((value) => value.slice(0, index));
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
  const rootLocation = page?.breadcrumbs?.[0]?.location ?? catalogRoot.current;
  const breadcrumbs = history.flatMap((item, index) =>
    item.location &&
    item.location !== rootLocation &&
    item.title &&
    !history
      .slice(0, index)
      .some((value) => value.location === item.location && value.search === item.search)
      ? [{ ...item, index }]
      : [],
  );
  const count =
    publications.length +
    (page?.groups?.reduce((total, group) => total + group.publications.length, 0) ?? 0);
  const pageTitle = location.search
    ? msg('搜索结果')
    : page?.title ?? location.title ?? account?.displayName;
  useLayoutEffect(() => {
    const trail = breadcrumbTrail.current;
    if (trail) trail.scrollLeft = document.documentElement.dir === 'rtl' ? -trail.scrollWidth : trail.scrollWidth;
  }, [accountId, history.length, pageTitle]);
  const connectionActions = account
    ? [
        { label: account.status === 'connected' ? msg('编辑书库') : msg('重新连接'), icon: 'settings', onSelect: () => setEditing(account) },
        ...(account.status !== 'disconnected'
          ? [
              {
                label: msg('断开连接'),
                icon: 'close',
                danger: true,
                onSelect: () => setDisconnecting(account),
              },
            ]
          : []),
        ...(connectionCapabilities(account).canRemove
          ? [{ label: msg('移除书库'), icon: 'trash' as const, danger: true, onSelect: () => setRemoving(account) }]
          : []),
      ]
    : [];
  const searchable = !blocked && !!(page?.searchable || location.search);
  const searchForm = (
    <form
      className="nc-remote-search"
      data-unavailable={!searchable || undefined}
      aria-hidden={!searchable || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!page || !searchable || busy) return;
        if (!search.trim()) {
          if (location.search) {
            if (history.length) back();
            else reset(accountId);
          }
          return;
        }
        if (search.trim() !== location.search)
          navigate(
            {
              location: location.searchLocation ?? page.location,
              searchLocation: location.searchLocation ?? page.location,
              search: search.trim(),
              title: msg('搜索结果'),
              scrollTop: 0,
            },
            !!location.search,
          );
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
          disabled={!searchable || busy}
          maxLength={256}
        />
      </label>
    </form>
  );
  return (
    <section className="nc-remote-library" aria-label={msg('远程书库')}>
      <div className="nc-page-heading nc-remote-heading">
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
        <div className="nc-remote-layout">
          <aside className="nc-remote-sidebar">
            <h2>
              {msg('已连接的书库')}
              <span>{accounts.length}</span>
            </h2>
            <nav className="nc-remote-connections" aria-label={msg('已连接的书库')}>
              {accounts.map((item) => (
                <button
                  key={item.id}
                  className="nc-remote-connection"
                  aria-pressed={item.id === accountId}
                  onClick={() => {
                    if (item.id !== accountId) reset(item.id);
                  }}
                >
                  <Icon name="cloud" size={22} />
                  <span>
                    <strong>{item.displayName}</strong>
                    <small data-blocked={item.status !== 'connected' || undefined}>
                      {item.status === 'disconnected'
                        ? msg('已断开连接')
                        : item.status === 'connected'
                          ? msg('已连接')
                          : msg('需要重新连接')}
                    </small>
                  </span>
                  {item.id === accountId && <Icon name="chevron" size={16} />}
                </button>
              ))}
            </nav>
            <p className="nc-remote-sidebar-note">
              {msg('连接后浏览远程目录，打开时才加入我的漫画。')}
            </p>
          </aside>
          <div className="nc-remote-content" aria-busy={busy}>
            {account && (
              <>
                <nav className="nc-remote-breadcrumbs" aria-label={msg('书库目录')}>
                  <button
                    className="nc-remote-back"
                    disabled={!history.length || busy}
                    onClick={() => back()}
                    aria-label={msg('返回上级')}
                    title={msg('返回上级')}
                  >
                    <Icon name="arrow" style={{ transform: 'rotate(180deg)' }} size={18} />
                  </button>
                  <ol ref={breadcrumbTrail}>
                    <li>
                      <button className="nc-remote-crumb" disabled={busy} onClick={() => reset(accountId)}>
                        <Icon name="home" size={18} />
                        {msg('书库首页')}
                      </button>
                    </li>
                    {breadcrumbs.map((item) => (
                      <li key={item.index}>
                        <Icon name="chevron" size={14} />
                        <button
                          className="nc-remote-crumb"
                          disabled={busy}
                          onClick={() => back(item.index)}
                          title={item.search ? msg('搜索结果') : item.title}
                        >
                          <span>{item.search ? msg('搜索结果') : item.title}</span>
                        </button>
                      </li>
                    ))}
                    <li aria-current="page">
                      <Icon name="chevron" size={14} />
                      <span className="nc-remote-crumb nc-remote-crumb-current" title={pageTitle}>
                        <Icon name={location.search ? 'search' : 'folder'} size={18} />
                        <span>{pageTitle}</span>
                      </span>
                    </li>
                  </ol>
                </nav>
                <div className="nc-remote-toolbar">
                  <div className="nc-remote-title">
                    <h2 title={pageTitle}>{pageTitle}</h2>
                    <span
                      className="nc-remote-count"
                      data-pending={!page || busy || blocked || undefined}
                      title={msg('本页 {0} 本', { '0': count })}
                    >
                      <span className="nc-remote-count-width" aria-hidden="true">
                        {msg('本页 {0} 本', { '0': '00000' })}
                      </span>
                      <span className="nc-remote-count-value">{msg('本页 {0} 本', { '0': count })}</span>
                    </span>
                  </div>
                  {searchForm}
                  <div className="nc-remote-toolbar-actions">
                    <button
                      className="icon-button"
                      aria-label={msg('刷新')}
                      title={msg('刷新')}
                      disabled={busy || blocked}
                      onClick={() => {
                        setLocation((value) => ({ ...value, scrollTop: window.scrollY }));
                        setRefresh((value) => value + 1);
                      }}
                    >
                      <Icon name="refresh" size={18} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={msg('管理书库')}
                      title={msg('管理书库')}
                      aria-haspopup="menu"
                      onClick={(event) =>
                        menu.open(event.currentTarget, account.displayName, connectionActions)
                      }
                    >
                      <Icon name="more" size={20} />
                    </button>
                  </div>
                </div>
              </>
            )}
            {blocked ? (
              <div className="nc-empty nc-remote-empty" role="status">
                <Icon name="cloud" size={40} />
                <h3>{msg('需要重新连接')}</h3>
                <p>{msg('书库需要重新连接，请更新授权后继续。')}</p>
                <button className="button primary" onClick={() => setEditing(account)}>
                  {msg('重新连接')}
                </button>
              </div>
            ) : (
              <>
                {location.search && (
                  <p className="nc-remote-query">
                    {msg('搜索结果')}
                    <strong>{location.search}</strong>
                  </p>
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
                        onClick={() =>
                          navigate({ location: item.location, title: item.title, scrollTop: 0 })
                        }
                      >
                        <Icon name="folder" size={24} />
                        <span>{item.title}</span>
                        <Icon name="chevron" size={16} />
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
                              onClick={() => navigate({ location: link.location, title: page.title, scrollTop: 0 })}
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
                  !error &&
                  !publications.length &&
                  !page.navigation.length &&
                  !page.groups?.length && (
                    <div className="nc-empty nc-remote-empty">
                      <Icon name={location.search ? 'search' : 'folder'} size={40} />
                      <h3>
                        {location.search
                          ? msg('没有找到匹配的漫画。')
                          : msg('此目录暂无可显示的内容。')}
                      </h3>
                      {location.search && (
                        <button
                          className="button secondary"
                          onClick={() => {
                            if (history.length) back();
                            else reset(accountId);
                          }}
                        >
                          {msg('清除搜索')}
                        </button>
                      )}
                    </div>
                  )}
                {!!publications.length && (
                  <div className="nc-remote-grid">
                    {publications.map((publication) => (
                      <PublicationCard
                        key={publication.id}
                        active={active && !blocked}
                        connectionId={accountId}
                        publication={publication}
                        busy={!!opening || busy}
                        onRead={() => void read(publication)}
                        onDetails={() => setDetails(publication)}
                      />
                    ))}
                  </div>
                )}
                {page?.groups?.map((group, index) => (
                  <section className="nc-remote-group" key={index}>
                    <div className="nc-remote-group-heading">
                      <h3>{group.title}</h3>
                      <span>{group.publications.length}</span>
                      {!!group.navigation.length && (
                        <nav className="nc-remote-group-links">
                          {group.navigation.map((item) => (
                            <button
                              key={item.id}
                              className="text-link"
                              disabled={busy}
                              onClick={() =>
                                navigate({ location: item.location, title: item.title, scrollTop: 0 })
                              }
                            >
                              {item.title}
                              <Icon name="arrow" size={16} />
                            </button>
                          ))}
                        </nav>
                      )}
                    </div>
                    <div className="nc-remote-grid">
                      {group.publications.map((publication) => (
                        <PublicationCard
                          key={publication.id}
                          active={active && !blocked}
                          connectionId={accountId}
                          publication={publication}
                          busy={!!opening || busy}
                          onRead={() => void read(publication)}
                          onDetails={() => setDetails(publication)}
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
                          navigate(
                            {
                              location: page.location,
                              title: page.title,
                              cursor: page.previous,
                              search: location.search,
                              searchLocation: location.searchLocation,
                              scrollTop: 0,
                            },
                            true,
                          )
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
                          navigate(
                            {
                              location: page.location,
                              title: page.title,
                              cursor: page.next,
                              search: location.search,
                              searchLocation: location.searchLocation,
                              scrollTop: 0,
                            },
                            true,
                          )
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
          </div>
        </div>
      )}
      {menu.menu}
      {details && (
        <Modal
          title={details.title}
          onClose={() => setDetails(undefined)}
          className="nc-remote-details"
        >
          {!!details.authors?.length && <p className="nc-muted">{details.authors.join(' · ')}</p>}
          {!!details.formats?.length && (
            <p className="nc-remote-formats">{details.formats.join(' · ')}</p>
          )}
          {details.summary && <p className="nc-remote-summary">{details.summary}</p>}
          {details.reason && <p className="nc-remote-unavailable">{details.reason}</p>}
          {details.readable !== false && (
            <button
              className="button primary"
              disabled={!!opening}
              onClick={() => {
                const publication = details;
                setDetails(undefined);
                void read(publication);
              }}
            >
              <Icon name="book" size={18} />
              {msg('开始阅读')}
            </button>
          )}
        </Modal>
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
      {removing && (
        <RemoveConnectionDialog
          account={removing}
          onClose={() => setRemoving(undefined)}
          onRemoved={() => {
            setRemoving(undefined);
            if (accountId === removing.id) reset('');
            void reloadAccounts();
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
                  .catch((error) => {
                    if (current.current.active && current.current.accountId === item.id)
                      setActionError(error.message);
                  });
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
  onDetails,
}: {
  active: boolean;
  connectionId: string;
  publication: RemotePublication;
  busy: boolean;
  onRead: () => void;
  onDetails: () => void;
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
      <div className="nc-remote-cover-frame">
        <button
          className="nc-remote-cover"
          disabled={busy || publication.readable === false}
          onClick={onRead}
          aria-label={msg('打开漫画 {0}', { '0': publication.title })}
          title={publication.reason || publication.title}
        >
          {url ? <img src={url} alt="" loading="lazy" /> : <Icon name="book" size={48} />}
          {publication.readable !== false && (
            <span className="nc-remote-cover-action">
              <Icon name="book" size={18} />
              {msg('开始阅读')}
            </span>
          )}
        </button>
        {!!publication.formats?.length && (
          <div className="nc-remote-cover-formats">
            {publication.formats.map((format) => (
              <span className="nc-remote-cover-tag" key={format}>{format.toUpperCase()}</span>
            ))}
          </div>
        )}
        <div className="nc-remote-cover-caption">
          {!!publication.size && (
            <span
              className="nc-remote-cover-tag nc-remote-cover-size"
              title={[publication.formats?.[0]?.toUpperCase(), fileSize(publication.size)].filter(Boolean).join(' · ')}
            >
              {fileSize(publication.size)}
            </span>
          )}
          {publication.readable === false && (
            <span className="nc-remote-cover-tag nc-remote-cover-unavailable">{msg('暂不可读')}</span>
          )}
        </div>
        <button
          className="icon-button nc-remote-details-button"
          aria-label={msg('查看详情：{0}', { '0': publication.title })}
          title={msg('查看详情：{0}', { '0': publication.title })}
          onClick={onDetails}
        >
          <Icon name="info" size={16} />
        </button>
      </div>
      <div className="nc-remote-publication-info">
        <h3>
          <button disabled={busy || publication.readable === false} onClick={onRead} title={publication.title}>
            {publication.title}
          </button>
        </h3>
      </div>
    </article>
  );
}
