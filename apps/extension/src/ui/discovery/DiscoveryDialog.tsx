import {useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import type {SearchSeed} from '../../comics/application/search/types';
import type {DiscoveryDetail, DiscoveryError, DiscoveryWork, PublicationStatus, WorkProvider, WorkRef} from '../../discovery/types';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {DiscoveryCover} from './DiscoveryCard';
import {DiscoveryBadge, DiscoveryGenreBadge} from './DiscoveryBadge';
import {DiscoveryNotice} from './DiscoveryNotice';
import {formatLabels, statusLabels} from './labels';
import type {TextTranslationSession} from '../../text-translation';
import {useTextTranslation} from './useTextTranslation';
import {TextTranslationStatus} from './TextTranslationStatus';
import {useDialogViewport} from '../visual-viewport';
import {WorkReviews} from '../comments/WorkReviews';
import {DialogSubject} from '../ConfirmationDialog';

export interface DiscoverySearchContext {
  seed: SearchSeed;
  workRef: WorkRef;
  open: boolean;
  isActive: () => boolean;
}
interface Props {
  active: boolean;
  provider: WorkProvider;
  work: DiscoveryWork;
  detail?: DiscoveryDetail;
  loading: boolean;
  error?: DiscoveryError;
  onRetry: () => void;
  onClose: () => void;
  renderSearch: (context: DiscoverySearchContext) => ReactNode;
  translator: TextTranslationSession;
  language: string;
  translate: boolean;
}
type Pane = 'details' | 'reviews' | 'sources';
const statusIcons: Record<PublicationStatus, string> = {releasing: 'bolt', finished: 'check', upcoming: 'clock', hiatus: 'stop', cancelled: 'close'};
const ratingOutline = 'm14 14 37 2 6-10 20 8 80-5-3 25 15 8-10 20 2 56-35-2-11 13-16-12-87 6 4-39-10-10 10-13Z';
/** The work stays open while browsing its details, reviews or reading sources. */
export function DiscoveryDialog({active, provider, work, detail, loading, error, onRetry, onClose, renderSearch, translator, language, translate}: Props) {
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const detailBody = useRef<HTMLDivElement>(null), detailScroll = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<Pane>('details');
  const [sourceSeed, setSourceSeed] = useState<SearchSeed>();
  const [expanded, setExpanded] = useState(false);
  useDialogViewport(dialog, active);
  const searching = pane === 'sources', reviewing = pane === 'reviews';
  const [originalTitle, setOriginalTitle] = useState(false), [originalDescription, setOriginalDescription] = useState(false);
  useEffect(() => {setOriginalTitle(false); setOriginalDescription(false);}, [language]);
  const titleTranslation = useTextTranslation(translator, (detail ?? work).title, language, active && !searching, translate);
  const descriptionTranslation = useTextTranslation(translator, detail?.description ?? '', language, active && pane === 'details', translate);
  const current = useRef({active, pane});
  current.current = {active, pane};
  const scroll = useRef({details: 0, sources: 0}), returnFocus = useRef<HTMLElement | null>(null);
  const scrollArea = (key: 'details' | 'sources') => key === 'sources' ? dialog.current : detailScroll.current && getComputedStyle(detailScroll.current).overflowY === 'auto' ? detailScroll.current : detailBody.current;
  const rememberScroll = () => {
    const key = current.current.pane;
    if (key !== 'reviews') scroll.current[key] = scrollArea(key)?.scrollTop ?? 0;
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
    if (!active) return;
    const element = pane === 'reviews' ? detailScroll.current : scrollArea(pane);
    if (element) element.scrollTop = pane === 'reviews' ? 0 : scroll.current[pane];
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
    setSourceSeed(seed => seed ?? {title: work.title, titles: detail?.titles ?? work.titles, sourceName: provider.label});
    showPane('sources');
  };
  const value = detail ?? work;
  return <dialog ref={dialog} className={`nc-discovery-dialog${searching ? ' is-searching' : ''}`} aria-label={work.title} onCancel={event => {
    event.preventDefault();
    if (reviewing) {showPane('details'); reviewTrigger.current?.focus({preventScroll:true});} else close();
  }}>
    <header className="nc-discovery-dialog-header">
      {searching && <button className="button secondary small" onClick={() => showPane('details')}>{msg('返回作品详情')}</button>}
      {!searching && provider.reviews && <div className="nc-discovery-sections" role="group" aria-label={work.title}>
        <button type="button" aria-pressed={!reviewing} onClick={() => showPane('details')}><Icon name="book" size={18}/>{msg('作品详情')}</button>
        <button ref={reviewTrigger} type="button" aria-pressed={reviewing} onClick={() => showPane('reviews')}><Icon name="message" size={18}/>{msg('作品评论')}</button>
      </div>}
      <button ref={closeButton} className="icon-button" aria-label={msg('关闭弹窗')} onClick={close}><Icon name="close"/></button>
    </header>
    <div ref={detailScroll} className={`nc-discovery-detail${reviewing ? ' is-reviewing' : ''}`} hidden={searching}>
      <aside className="nc-discovery-detail-art">
        <DiscoveryCover work={value}/>
      </aside>
      <article className="nc-discovery-detail-copy">
          <header className="nc-discovery-detail-heading">
            <div className="nc-discovery-detail-identity">
              <h2>{!originalTitle && titleTranslation.text ? titleTranslation.text : value.title}</h2>
              <div className="nc-discovery-detail-facts">
                {value.year && <div className="nc-discovery-detail-year"><span><Icon name="calendar" size={16}/>{msg('年份')}</span><time dateTime={String(value.year)}>{value.year}</time></div>}
                <div className="nc-discovery-publication-types">
                  <div className="nc-discovery-publication-badges">
                    {value.status && <DiscoveryBadge kind="status" className={`is-${value.status}`} icon={statusIcons[value.status]}>
                      {statusLabels()[value.status]}
                    </DiscoveryBadge>}
                    {value.format && <DiscoveryBadge kind="format" icon={value.format === 'oneshot' ? 'page-unread' : 'book'} className="nc-discovery-format">{formatLabels()[value.format]}</DiscoveryBadge>}
                  </div>
                  <TextTranslationStatus pending={titleTranslation.pending} error={titleTranslation.error} translated={!!titleTranslation.text} original={originalTitle} onOriginal={() => setOriginalTitle(value => !value)} onRetry={titleTranslation.retry} onTranslate={titleTranslation.retry}/>
                </div>
              </div>
            </div>
            {value.score !== undefined && <div className="nc-discovery-detail-rating" aria-label={msg('{provider} 评分 {0}/100', {provider: provider.label, '0': value.score})}>
              <svg className="nc-discovery-rating-paper" viewBox="0 0 180 136" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                <path className="nc-discovery-rating-shadow" d={ratingOutline} transform="translate(3 3)"/>
                <path className="nc-discovery-rating-outline" d={ratingOutline} vectorEffect="non-scaling-stroke"/>
                <path className="nc-discovery-rating-hatch" d="m22 101 10-10m-8 18 18-18m-8 19 9-9m93-70 9-9m-1 17 7-7" vectorEffect="non-scaling-stroke"/>
              </svg>
              <Icon className="nc-discovery-rating-spark" name="spark" size={32}/>
              <b>{value.score}</b><small>/100</small>
            </div>}
          </header>
          {!reviewing && value.genres.length > 0 && <div className="nc-discovery-detail-tags">{value.genres.map(genre => <DiscoveryGenreBadge genre={genre} key={genre}/>)}</div>}
          {!reviewing && detail && detail.contributors.length > 0 && <dl className="nc-discovery-contributors">{detail.contributors.map((person, index) => <div key={index}><dt><Icon name="user" size={16}/>{person.role}</dt><dd>{person.name}</dd></div>)}</dl>}
          <div ref={detailBody} className="nc-discovery-detail-body" data-scrollbar-mode="overlay" tabIndex={0} hidden={reviewing}>
            {loading && <p role="status">{msg('正在加载作品资料…')}</p>}
            {error && <DiscoveryNotice provider={provider.label} error={error} onRetry={onRetry}/>}
            {detail?.description && <div className="nc-discovery-description">
              <div className="nc-discovery-description-controls">
                <TextTranslationStatus pending={descriptionTranslation.pending} error={descriptionTranslation.error} translated={!!descriptionTranslation.text} original={originalDescription} onOriginal={() => setOriginalDescription(value => !value)} onRetry={descriptionTranslation.retry} onTranslate={descriptionTranslation.retry}/>
                <button className="nc-search-text-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? msg('收起简介') : msg('展开简介')}</button>
              </div>
              <p className={expanded ? undefined : 'is-collapsed'}>{!originalDescription && descriptionTranslation.text ? descriptionTranslation.text : detail.description}</p>
            </div>}
            {value.titles.length > 1 && <details className="nc-discovery-aliases"><summary>{msg('作品别名')}</summary><div>{value.titles.filter(title => title !== value.title).map(title => <DiscoveryBadge kind="alias" icon="message" key={title}>{title}</DiscoveryBadge>)}</div></details>}
          </div>
          {active && reviewing && <section className="nc-discovery-reviews" aria-label={msg('作品评论')}>
            <WorkReviews provider={provider} workId={work.id}/>
          </section>}
          <footer className="nc-discovery-detail-footer">
            <button className="button primary nc-comic-action" onClick={startSearch}>{msg('查找阅读来源')}<Icon name="arrow" size={19}/></button>
            <a className="nc-discovery-inline-action" href={work.url} target="_blank" rel="noopener noreferrer"><span>{msg('在 {provider} 查看', {provider: provider.label})}</span><Icon name="external" size={14}/></a>
            <p>{msg('作品资料来自 {provider}，阅读内容由所选网站提供。', {provider: provider.label})}</p>
          </footer>
      </article>
    </div>
    {sourceSeed && <div className="nc-discovery-source-search" hidden={!searching}>
      <DialogSubject icon="layers" title={msg('作品关联')} meta={msg('所选阅读来源将关联到 {provider} 的《{title}》。', {provider: provider.label, title: work.title})}/>
      {renderSearch({seed: sourceSeed, workRef: {providerId: provider.id, workId: work.id}, open: active && searching, isActive: () => current.current.active && current.current.pane === 'sources'})}
    </div>}
  </dialog>;
}
