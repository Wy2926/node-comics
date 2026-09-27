import {useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {createAniListProvider} from '../../discovery/anilist';
import {DiscoverySession} from '../../discovery/session';
import {Icon} from '../../icons';
import {msg} from '../../i18n/runtime';
import {DiscoveryCard} from './DiscoveryCard';
import {DiscoveryControls} from './DiscoveryControls';
import {DiscoveryDialog, type DiscoverySearchContext} from './DiscoveryDialog';
import {DiscoveryNotice} from './DiscoveryNotice';
import './discovery.css';

export function DiscoveryPage({active, renderSearch, onSearchSites}: {
  active: boolean;
  renderSearch: (context: DiscoverySearchContext) => ReactNode;
  onSearchSites: () => void;
}) {
  const [{session, genres}] = useState(() => {
    const provider = createAniListProvider();
    return {session: new DiscoverySession(provider), genres: provider.genres};
  });
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const scroll = useRef(0);
  const loadMore = useRef<HTMLDivElement>(null);
  useEffect(() => {void session.search(); return () => session.dispose();}, [session]);
  useLayoutEffect(() => {
    if (!active) return;
    // The app uses document scrolling; retain the list's position across navigation and reading.
    window.scrollTo(0, scroll.current);
    const remember = () => {scroll.current = window.scrollY;};
    window.addEventListener('scroll', remember);
    return () => window.removeEventListener('scroll', remember);
  }, [active]);
  useEffect(() => {
    if (!active || !state.hasMore || state.loading || state.error || state.selected || !loadMore.current) return;
    let observing = true;
    const observer = new IntersectionObserver(entries => {
      if (observing && entries.some(entry => entry.isIntersecting)) void session.more();
    }, {rootMargin: '480px 0px'});
    observer.observe(loadMore.current);
    return () => {observing = false; observer.disconnect();};
  }, [active, session, state.hasMore, state.loading, state.error, state.selected, state.page]);
  const paginationError = state.error && (state.failedPage ?? 1) > 1;
  const notice = state.error && <DiscoveryNotice error={state.error} cached={state.stale} onRetry={() => {void session.retry();}}/>;
  return <div className="nc-discovery" hidden={!active} aria-label={msg('发现')}>
    <DiscoveryControls query={state.query} genres={genres} count={state.works.length} loading={state.loading}
      refreshDisabled={state.loading || !!state.error}
      onChange={query => {void session.search(query);}} onRefresh={() => {void session.search(state.query, true);}}/>
    {!paginationError && notice}
    <div className="nc-discovery-grid" aria-busy={state.loading}>
      {state.works.map(work => <DiscoveryCard key={work.id} work={work} onOpen={() => {void session.select(work);}}/>)}
      {state.loading && !state.works.length && Array.from({length: 12}, (_, index) => <div key={index} className="nc-discovery-skeleton" aria-hidden="true"/>)}
    </div>
    {!state.loading && !state.error && !state.works.length && <div className="nc-search-empty"><Icon name="search" size={36}/><h2>{msg('没有符合条件的作品')}</h2><p>{msg('试试原名、英文名，或清空筛选。')}</p><button className="button secondary" onClick={onSearchSites}><Icon name="comic-search"/>{msg('搜索漫画')}</button></div>}
    {state.hasMore && <div ref={loadMore} className="nc-discovery-pagination">
      {paginationError ? notice : state.loading && <span role="status">{msg('加载中…')}</span>}
    </div>}
    {state.selected && <DiscoveryDialog key={state.selected.id} active={active} work={state.selected} detail={state.detail} loading={state.detailLoading} error={state.detailError} onRetry={() => {if (state.selected) void session.select(state.selected);}} onClose={() => session.close()} renderSearch={renderSearch}/>}
  </div>;
}
