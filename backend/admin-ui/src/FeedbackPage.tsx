import {useEffect, useRef, useState} from 'react';
import {ApiError, authError, errorText, request} from './api';
import {BillingDialog, useBillingResource} from './BillingShared';
import {Empty, Jump, label, Pagination, Table, time} from './ui';
import './CareOperations.css';

const statuses: Record<string, string> = {received: '待处理', reviewing: '处理中', resolved: '已解决'};
const issues: Record<string, string> = {missing_text: '漏译', meaning: '译文含义', typesetting: '排版', art_changed: '画面变化', other: '其他'};
type Feedback = {id: string; owner_id: string; owner_name: string; job_id: string; actual_job_id: string; access_id: string | null; output_asset_id: string;
  issues: string[]; comment: string; status: string; created_at: string; updated_at: string; result_version: number; mode: string; target_language: string;
  reviewer_id: string | null; reviewer_name: string | null; review_note: string | null; reviewed_at: string | null};
type Review = {id: string; actor_id: string; actor_name: string; from_status: string; to_status: string; note: string; created_at: string};
type Page<T> = {items: T[]; total: number; next_offset: number | null};
type Pending = {key: string; body: {status: string; expected_status: string; expected_updated_at: string; note: string}};
const Status = ({value}: {value: string}) => <span className={`care-status care-status-${value}`}>{statuses[value] || value}</span>;

function FeedbackDetail({id, onClose, onChanged, onUnauthorized}: {id: string; onClose: () => void; onChanged: () => Promise<void>; onUnauthorized: (message: string) => void}) {
  const {data, loading, error, reload} = useBillingResource<Feedback>(`/v1/admin/feedback/${encodeURIComponent(id)}`, onUnauthorized);
  const [offset, setOffset] = useState(0);
  const reviews = useBillingResource<Page<Review>>(`/v1/admin/feedback/${encodeURIComponent(id)}/reviews?offset=${offset}&limit=25`, onUnauthorized);
  const storageKey = `nc-admin-benefit:feedback:${id}`;
  const [pending, setPending] = useState<Pending | undefined>(() => {try {return JSON.parse(sessionStorage.getItem(storageKey) || 'null') || undefined;} catch {return undefined;}});
  const [status, setStatus] = useState('reviewing'), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [actionError, setActionError] = useState(''), [notice, setNotice] = useState('');
  const locked = useRef(false);
  useEffect(() => {if (data) setStatus(data.status === 'received' ? 'reviewing' : data.status);}, [data]);
  function save(operation?: Pending) {if (operation) sessionStorage.setItem(storageKey, JSON.stringify(operation)); else sessionStorage.removeItem(storageKey); setPending(operation);}
  async function submit() {
    if (!data || locked.current) return;
    locked.current = true; setBusy(true); setActionError(''); setNotice('');
    try {
      const operation = pending || {key: crypto.randomUUID(), body: {status, expected_status: data.status, expected_updated_at: data.updated_at, note: note.trim()}};
      if (!operation.body.note) throw Error('请填写处理备注。');
      save(operation);
      await request(`/v1/admin/feedback/${encodeURIComponent(id)}`, {method: 'PATCH', headers: {'Content-Type': 'application/json', 'Idempotency-Key': operation.key}, body: JSON.stringify(operation.body)});
      save(); setNote(''); setNotice('处理记录已保存。');
      await Promise.all([reload(), reviews.reload(), onChanged()]);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {save(); if (failure.status === 409) await reload();}
      if (authError(failure)) onUnauthorized(errorText(failure)); else setActionError(errorText(failure));
    } finally {locked.current = false; setBusy(false);}
  }
  return <BillingDialog title="翻译反馈处理" onClose={onClose} busy={busy}>
    <div className="care-feedback-detail">
    {error && <p className="error" role="alert">{error}</p>}
    {!data ? <p role="status">{loading ? '正在读取反馈…' : '无法读取反馈，请刷新重试。'}</p> : <>
      <section className="care-feedback-issue" aria-labelledby="feedback-issue-title">
        <div className="care-section-heading"><div><h3 id="feedback-issue-title">用户问题</h3><p className="care-subtitle"><Jump view="users" params={{q: data.owner_id}}>{data.owner_name}</Jump><span>提交于 {time(data.created_at)}</span></p></div><Status value={data.status}/></div>
        <div className="care-issue-tags" aria-label="问题类型">{data.issues.length ? data.issues.map(value => <span key={value}>{issues[value] || value}</span>) : <span>补充说明</span>}</div>
        <div className="care-user-comment"><span className="care-label">用户说明</span><p>{data.comment || '用户未填写补充说明。'}</p></div>
        <dl className="care-result-context"><div><dt>关联任务</dt><dd><Jump view="tasks" params={{q: data.actual_job_id}}><code>{data.actual_job_id}</code></Jump></dd></div><div><dt>结果版本</dt><dd>{label(data.mode)} · {data.target_language} · 第 {data.result_version} 版{data.access_id && <span className="care-inline-tag">复用结果</span>}</dd></div>
          <div><dt>具体译图</dt><dd><code>{data.output_asset_id}</code></dd></div>{data.access_id && <div><dt>复用授权</dt><dd><code>{data.access_id}</code></dd></div>}</dl>
      </section>
      {notice && <p className="settings-notice" role="status">{notice}</p>}{actionError && <p className="error" role="alert">{actionError}</p>}
      <section className="care-operation-panel" aria-labelledby="feedback-action-title">
        <div className="care-section-heading"><div><h3 id="feedback-action-title">处理操作</h3><p className="care-subtitle">{data.reviewer_name ? `最近由 ${data.reviewer_name} 处理 · ${time(data.reviewed_at)}` : '尚未处理，核实问题后记录处理结果。'}</p></div></div>
        {pending ? <div className="care-operation-receipt"><p className="care-state-change"><Status value={pending.body.expected_status}/><span aria-hidden="true">→</span><Status value={pending.body.status}/></p><p className="care-receipt-note">{pending.body.note}</p><p className="care-subtitle" role="status">{busy ? '正在保存…' : '提交结果尚未确认；恢复原操作会沿用同一编号，不会重复记录。'}</p><div className="care-action-footer"><button className="primary" disabled={busy || loading || !!error} onClick={() => void submit()}>恢复原处理操作</button></div></div>
        : <form className="care-form" onSubmit={event => {event.preventDefault(); void submit();}}><fieldset disabled={busy || loading || !!error}>
          <div className="care-feedback-state-row"><label>处理状态<select value={status} onChange={event => setStatus(event.target.value)}>{Object.entries(statuses).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><div className="care-impact"><span className="care-label">操作影响</span><p>{status === data.status ? '保持当前状态，追加一条处理备注。' : `将反馈从「${statuses[data.status]}」更新为「${statuses[status]}」。`}保存处理人、备注与历史记录。</p></div></div>
          <label>处理备注<textarea required maxLength={500} rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="记录核实情况、处理结果或后续安排"/></label><div className="care-action-footer"><small>备注必填 · {note.length} / 500</small><button className="primary" disabled={!note.trim()}>保存处理记录</button></div>
        </fieldset></form>}
      </section>
      <section className="care-review-history" aria-labelledby="feedback-history-title"><div className="care-section-heading"><h3 id="feedback-history-title">处理历史{reviews.data && <span className="care-count">{reviews.data.total}</span>}</h3><button className="secondary" disabled={loading || busy} onClick={() => void Promise.all([reload(), reviews.reload()])}>刷新反馈</button></div>
        {reviews.error && <p className="error" role="alert">{reviews.error} <button className="text-link" onClick={() => void reviews.reload()}>重试</button></p>}
        {reviews.data ? <>{reviews.data.items.length ? <Table heads={['时间 / 处理人', '状态变化', '备注']}>{reviews.data.items.map(review => <tr key={review.id}><td><span className="care-table-time">{time(review.created_at)}</span><small>{review.actor_name}</small></td><td><span className="care-state-change"><Status value={review.from_status}/><span aria-hidden="true">→</span><Status value={review.to_status}/></span></td><td className="care-note-cell">{review.note}</td></tr>)}</Table> : <div className="care-empty"><span aria-hidden="true">◇</span><div><strong>尚无处理记录</strong><p>保存首次处理后，将在这里显示处理人和状态变化。</p></div></div>}{reviews.data.total > 0 && <Pagination total={reviews.data.total} count={reviews.data.items.length} offset={offset} next={reviews.data.next_offset} onPage={setOffset}/>}</> : <p role="status">{reviews.loading ? '正在读取处理历史…' : '无法读取处理历史。'}</p>}
      </section>
    </>}
    {!data && <button className="secondary" disabled={loading || busy} onClick={() => void reload()}>刷新反馈</button>}
    </div>
  </BillingDialog>;
}

export function FeedbackPage({params, onNavigate, onUnauthorized}: {params: URLSearchParams; onNavigate: (values: Record<string, string>) => void; onUnauthorized: (message: string) => void}) {
  const query = new URLSearchParams({limit: '25'});
  for (const name of ['status', 'issue', 'owner_id', 'job_id', 'offset']) if (params.get(name)) query.set(name, params.get(name)!);
  const {data, loading, error, reload} = useBillingResource<Page<Feedback>>(`/v1/admin/feedback?${query}`, onUnauthorized);
  const [detail, setDetail] = useState<string>();
  useEffect(() => {document.title = '翻译反馈 · Node Comics 管理后台';}, []);
  return <main id="main" tabIndex={-1} className="care-feedback-page">
    <div className="page-heading"><div><p className="eyebrow">TRANSLATION FEEDBACK</p><h1>翻译反馈</h1><p className="muted">按具体译图版本核实问题，保留处理人与历史。</p></div><button className="secondary" disabled={loading} onClick={() => void reload()}>{loading ? '正在刷新…' : '刷新反馈'}</button></div>
    <section className="filters"><form className="filter-form" key={params.toString()} onSubmit={event => {event.preventDefault(); const values = Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, String(value).trim()]).filter(([, value]) => value)); onNavigate(values);}}>
      <label>状态<select name="status" defaultValue={params.get('status') || ''}><option value="">全部状态</option>{Object.entries(statuses).map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label>
      <label>问题类型<select name="issue" defaultValue={params.get('issue') || ''}><option value="">全部问题</option>{Object.entries(issues).map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label>
      <label>用户 ID<input name="owner_id" maxLength={36} defaultValue={params.get('owner_id') || ''}/></label><label>任务 / 复用授权 ID<input name="job_id" maxLength={36} defaultValue={params.get('job_id') || ''}/></label>
      <button className="primary">筛选</button><button type="button" className="secondary" onClick={() => onNavigate({})}>重置</button></form></section>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel list-panel" aria-busy={loading}>{!data ? <p role="status">{loading ? '正在读取反馈…' : '无法读取反馈，请刷新重试。'}</p> : <>
      {!data.items.length ? <Empty>暂无符合条件的反馈</Empty> : <Table heads={['用户 / 提交时间', '问题 / 说明', '任务与版本', '状态 / 处理人', '操作']}>{data.items.map(row => <tr key={row.id}>
        <td><Jump view="users" params={{q: row.owner_id}}>{row.owner_name}</Jump><small className="care-table-time">{time(row.created_at)}</small></td><td className="care-feedback-list-comment"><strong>{row.issues.map(value => issues[value] || value).join('、') || '补充说明'}</strong><small>{row.comment.slice(0, 100) || '未填写补充说明'}{row.comment.length > 100 ? '…' : ''}</small></td>
        <td><Jump view="tasks" params={{q: row.actual_job_id}}><code>{row.actual_job_id}</code></Jump><small>{label(row.mode)} · 第 {row.result_version} 版{row.access_id ? ' · 复用' : ''}</small></td><td><Status value={row.status}/><small>{row.reviewer_name || '尚未处理'}</small></td><td><button className="text-link" onClick={() => setDetail(row.id)}>查看 / 处理</button></td></tr>)}</Table>}
      <Pagination total={data.total} count={data.items.length} offset={Number(params.get('offset') || 0)} next={data.next_offset} onPage={offset => onNavigate({...Object.fromEntries(params), offset: String(offset)})}/>
    </>}</section>
    {detail && <FeedbackDetail key={detail} id={detail} onClose={() => setDetail(undefined)} onChanged={reload} onUnauthorized={onUnauthorized}/>}
  </main>;
}
