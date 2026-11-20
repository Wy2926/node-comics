import {useCallback, useId, useLayoutEffect, useRef, useState, type Ref} from 'react';
import {coverReference, type Comic} from '../../comics/application/library-service';
import {setWorkLink} from '../../comics/application/work-links';
import type {DiscoveryWork, WorkProvider} from '../../discovery/types';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {Thumbnail} from '../../reader/Images';
import {DiscoveryCover} from '../discovery/DiscoveryCard';
import {DiscoveryNotice} from '../discovery/DiscoveryNotice';
import {formatLabels, statusLabels} from '../discovery/labels';
import {useWorkRequest} from '../discovery/useWorkRequest';
import './work-links.css';

function MatchCard({work, current, saving, onLink}: {
  work: DiscoveryWork; current: boolean; saving?: string | null; onLink: (id: string) => void;
}) {
  const heading = useId(), aliases = [...new Set(work.titles)].filter(title => title && title !== work.title);
  return <article className="nc-match-card" aria-labelledby={heading} aria-current={current || undefined}>
    <div className="nc-match-body">
      <div className="nc-match-jacket">
        <div className="nc-match-cover"><DiscoveryCover work={work}/></div>
        <div className="nc-match-imprint">
          <bdi id={heading + '-number'} className="nc-match-id">#{work.id}</bdi>
          <div className="nc-match-edition">{work.year && <time dateTime={String(work.year)}>{work.year}</time>}
            {work.format && <span>{formatLabels()[work.format]}</span>}{work.status && <span>{statusLabels()[work.status]}</span>}</div>
        </div>
      </div>
      <div className="nc-match-names"><h5 id={heading} dir="auto">{work.title}</h5>
        {aliases[0] && <p dir="auto">{aliases[0]}</p>}
      </div>
    </div>
    {aliases.length > 1 && <details className="nc-match-aliases"><summary>{msg('作品别名')} <b>+{aliases.length - 1}</b><Icon name="chevron" size={12}/></summary>
      <ul>{aliases.slice(1).map(title => <li key={title} dir="auto">{title}</li>)}</ul></details>}
    <footer><a href={work.url} target="_blank" rel="noopener noreferrer" aria-describedby={`${heading} ${heading}-number`}>
      {msg('查看资料')}<Icon name="external" size={13}/></a>
      <button type="button" className="nc-match-link" aria-describedby={`${heading} ${heading}-number`} disabled={saving !== undefined} onClick={() => onLink(work.id)}>
        {saving === work.id ? <><span className="spinner"/>{msg('正在保存…')}</> : <><Icon name={current ? 'check' : 'plus'} size={14}/>{current ? msg('当前关联') : msg('关联此作品')}</>}
      </button>
    </footer>
  </article>;
}

function WorkMatches({provider, query, linked, saving, onLink}: {
  provider: WorkProvider; query: string; linked?: string | null; saving?: string | null; onLink: (id: string) => void;
}) {
  const read = useCallback((signal: AbortSignal) => provider.search(query, signal), [provider, query]);
  const {value, error, loading, retry} = useWorkRequest(read);
  const results = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const section = results.current, pane = section?.parentElement, form = pane?.querySelector('form');
    if (loading || !section || !pane || !form) return;
    const bounds = pane.getBoundingClientRect(), top = section.getBoundingClientRect().top;
    // Reveal results in a short sheet without moving the underlying book or hiding the query.
    if (bounds.bottom - top < Math.min(160, bounds.height / 2))
      pane.scrollTop += top - bounds.top - parseFloat(getComputedStyle(pane).paddingTop) - form.offsetHeight - 8;
  }, [loading]);
  return <section ref={results} className="nc-work-matches" aria-label={msg('搜索结果')} aria-busy={loading}>
    <header><h4>{msg('搜索结果')}</h4><span role="status">{loading ? <><i className="spinner"/>{msg('搜索中')}</> : value && msg('{0} 个候选', {'0':value.length})}</span></header>
    {error && <DiscoveryNotice provider={provider.label} error={error} onRetry={retry}/>}
    {value?.length === 0 && <div className="nc-link-guide"><Icon name="search" size={24}/><div><b>{msg('没有找到这部作品')}</b>
      <p>{msg('试试其他译名，或粘贴作品链接。')}</p></div></div>}
    {!!value?.length && <div className="nc-match-list">{value.map(work =>
      <MatchCard key={work.id} work={work} current={work.id === linked} saving={saving} onLink={onLink}/>)}</div>}
  </section>;
}

export function WorkLinkEditor({comic, provider, linked, inputRef, onCancel}: {
  comic: Comic; provider: WorkProvider; linked?: string | null; inputRef: Ref<HTMLInputElement>; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(comic.title), [query, setQuery] = useState('');
  const [saving, setSaving] = useState<string | null>(), [error, setError] = useState('');
  const id = useId(), busy = saving !== undefined;
  async function save(target: string | null) {
    if (busy) return;
    setSaving(target); setError('');
    try {
      if (!await setWorkLink(comic.id, provider.id, target, linked)) setError(msg('作品关联已变更，请核对后重试。'));
      else if (target === linked) onCancel();
    } catch (reason) {setError((reason as Error).message);}
    finally {setSaving(undefined);}
  }
  return <section className="nc-comment-scroll nc-link-editor" aria-labelledby={id} data-scrollbar-mode="reserved">
    <div className="nc-link-tabline"><h3 id={id}><Icon name="layers" size={17}/>{msg('作品关联')}</h3>
      {linked && <button type="button" className="nc-link-back" disabled={busy} onClick={onCancel}><Icon name="chevron" size={13}/>{msg('取消')}</button>}</div>
    <div className="nc-link-file">
      <div className="nc-link-book"><Thumbnail className="nc-link-book-cover" blobKey={comic.source.status === 'active' ? coverReference(comic) : undefined}/>
        <div><small>{msg('我的漫画')}{comic.sourceName && <> · <bdi>{comic.sourceName}</bdi></>}</small><h4 dir="auto">{comic.title}</h4></div>
      </div>
      <div className="nc-link-binding"><div><small>{linked ? msg('当前关联') : msg('作品资料来源')}</small>
        <strong>{provider.label}</strong>{linked && <bdi>#{linked}</bdi>}</div>
        {linked ? <button type="button" disabled={busy} onClick={() => void save(null)}>{saving === null ? msg('正在保存…') : msg('解除关联')}</button> : <span>{msg('尚未关联')}</span>}
      </div>
    </div>
    <form className="nc-link-search" role="search" onSubmit={event => {event.preventDefault(); if (!busy) setQuery(draft.trim());}}>
      <label htmlFor={id + '-query'}>{msg('书名、作品链接或 id:编号')}</label>
      <div><Icon name="search" size={17}/><input id={id + '-query'} ref={inputRef} type="search" enterKeyHint="search" value={draft} maxLength={300}
        disabled={busy} placeholder={msg('输入漫画名称或别名')} onChange={event => {setDraft(event.target.value); setQuery('');}}/>
        <button type="submit" disabled={busy || !draft.trim()}>{msg('搜索')}</button></div>
    </form>
    {error && <p className="nc-error" role="alert">{error}</p>}
    {query ? <WorkMatches key={query} provider={provider} query={query} linked={linked} saving={saving} onLink={save}/> :
      <div className="nc-link-guide"><Icon name="comic-search" size={32}/><div><b>{msg('核对封面、别名和年份')}</b>
        {!linked && provider.reviews && <p>{msg('关联作品后可查看 {provider} 的书评。', {provider:provider.label})}</p>}</div></div>}
  </section>;
}
