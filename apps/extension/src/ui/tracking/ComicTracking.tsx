import {useEffect, useId, useRef, useState} from 'react';
import {msg} from '../../i18n/runtime';
import {trackingClient} from '../../tracking/client';
import {trackingFailure, trackingReason, trackingSearchQuery} from './presentation';
import {useTracking} from './useTracking';
import './tracking.css';

type Candidate = {id: number; title: string; chapters: number | null};
export function ComicTracking({comicId, title}: {comicId: string; title: string}) {
  const {view, error, busy, refresh, run} = useTracking(comicId);
  const [editing, setEditing] = useState(false), [query, setQuery] = useState(title), [results, setResults] = useState<Candidate[]>();
  const [selected, setSelected] = useState<Candidate>(), [offset, setOffset] = useState('0'), [confirmed, setConfirmed] = useState(false);
  const [searching, setSearching] = useState(false), [searchError, setSearchError] = useState(''), [confirmAction, setConfirmAction] = useState<'remove' | 'reset'>();
  const searchRevision = useRef(0), candidateGroup = useId();
  useEffect(() => () => { searchRevision.current++; }, []);
  // An account switch while the panel is open must not retain a staged binding or destructive confirmation.
  useEffect(() => { setEditing(false); setConfirmed(false); setConfirmAction(undefined); setSelected(undefined); setResults(undefined); searchRevision.current++; setSearching(false); }, [view?.account?.id, view?.binding?.mediaId, view?.binding?.offset]);
  const binding = view?.binding, job = view?.job;
  const validOffset = /^-?\d+$/.test(offset) && Number.isSafeInteger(Number(offset));
  const disabled = busy || searching;
  async function search() {
    const normalized = trackingSearchQuery(query);
    if (!normalized) { setSearchError(msg('请输入 AniList 漫画链接、正整数 ID 或作品名称。')); return; }
    const revision = ++searchRevision.current;
    setSearching(true); setSearchError(''); setSelected(undefined); setConfirmed(false); setResults(undefined);
    try {
      const values = await trackingClient.search(normalized);
      if (revision === searchRevision.current) setResults(values);
    } catch (error) { if (revision === searchRevision.current) setSearchError(trackingFailure(error)); }
    finally { if (revision === searchRevision.current) setSearching(false); }
  }
  function edit() {
    setEditing(true); setQuery(binding?.title ?? (view?.suggestedMediaId ? String(view.suggestedMediaId) : title)); setOffset(String(binding?.offset ?? 0)); setConfirmed(false); setConfirmAction(undefined); setSearchError('');
    setSelected(binding ? {id: binding.mediaId, title: binding.title, chapters: null} : undefined); setResults(undefined);
  }
  async function bind() {
    if (!selected || !confirmed || !validOffset || disabled) return;
    if (await run(() => trackingClient.bind(comicId, selected.id, Number(offset)))) setEditing(false);
  }
  const status = binding?.paused ? msg('已暂停') : job ? {pending: msg('待同步'), syncing: msg('同步中'), synced: msg('已同步'), blocked: msg('需要处理')}[job.status] : binding ? msg('等待读完下一章') : msg('未关联 AniList');
  return <section className="nc-tracking nc-tracking-comic" aria-label={msg('阅读追踪')}>
    <div className="nc-tracking-heading"><h3>{msg('阅读追踪')}</h3><span role="status" className="nc-tracking-status" data-state={binding?.paused ? 'paused' : job?.status}>{view ? status : msg('加载中…')}</span></div>
    {!view?.account && view && <p className="nc-muted">{msg('请先在外观与偏好中连接 AniList。')}</p>}
    {view?.account && <>
      {!view.enabled && <p className="nc-muted">{msg('自动追踪尚未开启，请在外观与偏好中启用。')}</p>}
      {binding && <>
        <a href={`https://anilist.co/manga/${binding.mediaId}`} target="_blank" rel="noopener noreferrer">{binding.title}</a>
        <p className="nc-muted">{msg('AniList 章节 = 来源章号 {0}', {'0': `${binding.offset < 0 ? '−' : '+'} ${Math.abs(binding.offset)}`})}</p>
        {job && <p>{msg('章节进度：{0}', {'0': job.progress})}</p>}
        {job?.reason && <p className="nc-tracking-note">{trackingReason(job.reason)}</p>}
        {!editing && <div className="nc-tracking-actions">
          <button type="button" className="button secondary small" disabled={disabled} onClick={() => void run(() => trackingClient.pause(comicId, !binding.paused))}>{binding.paused ? msg('恢复追踪') : msg('暂停')}</button>
          {job?.status === 'blocked' && !binding.paused && <button type="button" className="button secondary small" disabled={disabled} onClick={() => void run(() => trackingClient.retry(comicId))}>{msg('重试')}</button>}
          <button type="button" className="button secondary small" disabled={disabled} onClick={edit}>{msg('修改关联')}</button>
          <button type="button" className="button secondary small" disabled={disabled} onClick={() => setConfirmAction('remove')}>{msg('解除关联')}</button>
          {(job?.reason === 'remote-reset' || job?.reason === 'remote-deleted') && <button type="button" className="button secondary small" disabled={disabled} onClick={() => setConfirmAction('reset')}>{msg('接受远端进度，丢弃待同步记录')}</button>}
        </div>}
      </>}
      {!binding && !editing && <button type="button" className="button secondary" disabled={disabled} onClick={edit}>{msg('关联 AniList 作品')}</button>}
      {confirmAction && <div className="nc-tracking-confirm">
        <p>{confirmAction === 'reset' ? msg('丢弃该作品尚未同步的进度，保留 AniList 当前记录。之后仅同步新的阅读完成事件。') : msg('解除关联会丢弃此来源的待同步记录，但不删除 AniList 条目。')}</p>
        <div className="nc-tracking-actions">
          <button type="button" className="button primary small" disabled={disabled} onClick={() => void run(() => confirmAction === 'reset' ? trackingClient.resetBaseline(comicId) : trackingClient.unbind(comicId)).then(ok => { if (ok) setConfirmAction(undefined); })}>{confirmAction === 'reset' ? msg('接受远端进度，丢弃待同步记录') : msg('解除关联')}</button>
          <button type="button" className="button secondary small" disabled={disabled} onClick={() => setConfirmAction(undefined)}>{msg('取消')}</button>
        </div>
      </div>}
      {editing && <div className="nc-tracking-editor">
        <form onSubmit={event => { event.preventDefault(); if (!disabled) void search(); }}>
          <label className="field">{msg('AniList 漫画链接、ID 或名称')}<input value={query} maxLength={200} disabled={disabled} autoComplete="off" onChange={event => { setQuery(event.target.value); setSelected(undefined); setResults(undefined); setConfirmed(false); }}/></label>
          <button type="submit" className="button secondary small" disabled={disabled || !query.trim()}>{searching ? msg('搜索中') : msg('搜索')}</button>
        </form>
        {searchError && <p role="alert" className="nc-tracking-error">{searchError}</p>}
        {results && (results.length ? <fieldset className="nc-tracking-results"><legend>{msg('搜索结果')}</legend>{results.map(candidate => <label key={candidate.id}>
          <input type="radio" name={candidateGroup} checked={selected?.id === candidate.id} disabled={disabled} onChange={() => { setSelected(candidate); setConfirmed(false); }}/>
          <span>{candidate.title}{candidate.chapters !== null && <small>{msg('{0} 话', {'0': candidate.chapters})}</small>}</span>
        </label>)}</fieldset> : <p role="status">{msg('没有找到匹配的漫画。')}</p>)}
        {selected && <>
          <a href={`https://anilist.co/manga/${selected.id}`} target="_blank" rel="noopener noreferrer">{selected.title} · {msg('在 AniList 查看')}</a>
          <label className="field">{msg('章节偏移量')}<input type="number" step="1" value={offset} disabled={disabled} onChange={event => { setOffset(event.target.value); setConfirmed(false); }}/></label>
          <p className="nc-muted">{msg('AniList 章节 = 来源章号 {0}', {'0': validOffset ? `${Number(offset) < 0 ? '−' : '+'} ${Math.abs(Number(offset))}` : '—'})}</p>
          <p className="nc-muted">{msg('章节无法可靠换算。小数章、番外、整卷和重置编号不会自动取整同步。')}</p>
          <label className="nc-tracking-check"><input type="checkbox" checked={confirmed} disabled={disabled || !validOffset} onChange={event => setConfirmed(event.target.checked)}/><span>{msg('我已确认这是同一作品，且来源的整数章号加偏移量与 AniList 章节计数一致。')}</span></label>
        </>}
        <div className="nc-tracking-actions">
          <button type="button" className="button primary small" disabled={disabled || !selected || !confirmed || !validOffset} onClick={() => void bind()}>{msg('保存选择')}</button>
          <button type="button" className="button secondary small" disabled={busy} onClick={() => { searchRevision.current++; setSearching(false); setEditing(false); }}>{msg('取消')}</button>
        </div>
      </div>}
    </>}
    {error && <p role="alert" className="nc-tracking-error">{error} <button type="button" className="button secondary small" disabled={disabled} onClick={() => void refresh()}>{msg('刷新')}</button></p>}
  </section>;
}
