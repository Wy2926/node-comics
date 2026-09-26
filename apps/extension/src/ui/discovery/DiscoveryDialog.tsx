import {useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import type {SearchSeed} from '../../comics/application/search/types';
import type {DiscoveryDetail, DiscoveryError, DiscoveryWork} from '../../discovery/types';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {DiscoveryCover} from './DiscoveryCard';
import {DiscoveryNotice} from './DiscoveryNotice';
import {formatLabels, statusLabels} from './labels';

export interface DiscoverySearchContext {
  seed: SearchSeed;
  open: boolean;
  isActive: () => boolean;
}
interface Props {
  active: boolean;
  work: DiscoveryWork;
  detail?: DiscoveryDetail;
  loading: boolean;
  error?: DiscoveryError;
  onRetry: () => void;
  onClose: () => void;
  renderSearch: (context: DiscoverySearchContext) => ReactNode;
}
type Pane = 'details' | 'sources';
/** Owns only the details/search presentation. The host supplies the source-search workflow. */
export function DiscoveryDialog({active, work, detail, loading, error, onRetry, onClose, renderSearch}: Props) {
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const detailBody = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<Pane>('details');
  const [sourceSeed, setSourceSeed] = useState<SearchSeed>();
  const [expanded, setExpanded] = useState(false);
  const searching = pane === 'sources';
  const current = useRef({active, pane});
  current.current = {active, pane};
  const scroll = useRef({details: 0, sources: 0}), returnFocus = useRef<HTMLElement | null>(null);
  const scrollAreas = {details: detailBody, sources: dialog};
  const rememberScroll = () => {
    const key = current.current.pane;
    scroll.current[key] = scrollAreas[key].current?.scrollTop ?? 0;
  };
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!active || !element) return;
    if (!returnFocus.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    closeButton.current?.focus({preventScroll: true});
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      rememberScroll();
      element.close();
      document.body.style.overflow = overflow;
      current.current.active = false;
    };
  }, [active]);
  useLayoutEffect(() => {
    const element = scrollAreas[pane].current;
    if (active && element) element.scrollTop = scroll.current[pane];
  }, [active, pane]);
  const showPane = (next: Pane) => {
    rememberScroll();
    current.current.pane = next;
    setPane(next);
  };
  const close = () => {
    current.current.active = false;
    const previous = returnFocus.current;
    onClose();
    queueMicrotask(() => { if (previous?.isConnected) previous.focus({preventScroll: true}); });
  };
  const startSearch = () => {
    setSourceSeed(seed => seed ?? {title: work.title, titles: detail?.titles ?? work.titles, sourceName: 'AniList'});
    showPane('sources');
  };
  const value = detail ?? work;
  return <dialog ref={dialog} className={`nc-discovery-dialog${searching ? ' is-searching' : ''}`} aria-label={work.title} onCancel={event => {event.preventDefault(); close();}}>
    <header className="nc-discovery-dialog-header">
      {searching && <button className="button secondary small" onClick={() => showPane('details')}>{msg('返回作品详情')}</button>}
      <button ref={closeButton} className="icon-button" aria-label={msg('关闭弹窗')} onClick={close}><Icon name="close"/></button>
    </header>
    <div className="nc-discovery-detail" hidden={searching}>
      <aside className="nc-discovery-detail-art">
        <DiscoveryCover work={value}/>
      </aside>
      <article className="nc-discovery-detail-copy">
          <header className="nc-discovery-detail-heading">
            <div className="nc-discovery-detail-identity">
              <h2>{value.title}</h2>
              <div className="nc-discovery-detail-facts">
                {value.year && <div className="nc-discovery-detail-year"><span>{msg('年份')}</span><time dateTime={String(value.year)}>{value.year}</time></div>}
                <div className="nc-discovery-publication-types">
                  {value.status && <span className="nc-comic-tag nc-discovery-publication" data-status={value.status}>
                    {value.status === 'releasing' ? <i aria-hidden="true"/> : <Icon name={value.status === 'finished' ? 'check' : value.status === 'cancelled' ? 'close' : 'clock'} size={16}/>}
                    {statusLabels()[value.status]}
                  </span>}
                  {value.format && <span className="nc-comic-tag is-soft nc-discovery-format">{formatLabels()[value.format]}</span>}
                </div>
              </div>
            </div>
            {value.score !== undefined && <div className="nc-discovery-detail-rating" aria-label={msg('AniList 评分 {0}/100', {'0': value.score})}><b>{value.score}</b><small>/100</small></div>}
          </header>
          {value.genres.length > 0 && <div className="nc-discovery-detail-tags">{value.genres.map(genre => <span className="nc-comic-tag" key={genre}>{genre}</span>)}</div>}
          {detail && detail.contributors.length > 0 && <dl className="nc-discovery-contributors">{detail.contributors.map((person, index) => <div key={index}><dt>{person.role}</dt><dd>{person.name}</dd></div>)}</dl>}
          <div ref={detailBody} className="nc-discovery-detail-body" tabIndex={0}>
            {loading && <p role="status">{msg('正在加载作品资料…')}</p>}
            {error && <DiscoveryNotice error={error} onRetry={onRetry}/>}
            {detail?.description && <div className="nc-discovery-description"><p className={expanded ? undefined : 'is-collapsed'}>{detail.description}</p><button className="nc-search-text-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? msg('收起简介') : msg('展开简介')}</button></div>}
            {value.titles.length > 1 && <details className="nc-discovery-aliases"><summary>{msg('作品别名')}</summary><div>{value.titles.filter(title => title !== value.title).map(title => <span className="nc-comic-tag is-soft" key={title}>{title}</span>)}</div></details>}
          </div>
          <footer className="nc-discovery-detail-footer">
            <button className="button primary nc-comic-action" onClick={startSearch}>{msg('查找阅读来源')}<Icon name="arrow" size={19}/></button>
            <a href={work.url} target="_blank" rel="noopener noreferrer">{msg('在 AniList 查看')}<Icon name="external" size={14}/></a>
            <p>{msg('作品资料来自 AniList，阅读内容由所选网站提供。')}</p>
          </footer>
      </article>
    </div>
    {sourceSeed && renderSearch({seed: sourceSeed, open: active && searching, isActive: () => current.current.active && current.current.pane === 'sources'})}
  </dialog>;
}
