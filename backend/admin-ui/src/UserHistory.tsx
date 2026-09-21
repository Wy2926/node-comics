import {useCallback, useEffect, useRef, useState} from 'react';
import {useBillingResource} from './BillingShared';
import {Jump, label, Pagination, Table, time} from './ui';
import './CareOperations.css';

type Row = {id: string; kind?: string; mode?: string; source?: string; granted?: number; used?: number; reserved?: number; expires_at?: string; starts_at?: string; billing_term_id?: string;
  job_id?: string; period_id?: string; quota_kind?: string; amount?: number; note?: string; created_at?: string; operator_name?: string; operator_id?: string;
  details?: Record<string, string | number | null>; status?: string; quota_pages?: number; quota_period_id?: string};
type Page = {items: Row[]; total: number; next_offset: number | null};
const sources: Record<string, string> = {daily: '每日额度', membership: '运营会员', grant: '限时赠送', subscription: '付费订阅'};
const operations: Record<string, string> = {reserve: '预占', settle: '扣减', release: '释放', grant: '赠送', compensation: '补偿', compensate: '当期补偿', membership: '运营会员'};
function HistoryTime({value, prefix}: {value?: string; prefix?: string}) {
  if (!value) return <span className="care-subtitle">{prefix} —</span>;
  const date = new Date(value);
  return <time dateTime={value} className="care-history-time"><span>{prefix && <em>{prefix}</em>}{date.toLocaleDateString()}</span><small>{date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})}</small></time>;
}

export function UserHistory({userId, revision = '', onUnauthorized}: {userId: string; revision?: string | number; onUnauthorized?: (message: string) => void}) {
  const [tab, setTab] = useState('quota-periods'), [offset, setOffset] = useState(0), [periodId, setPeriodId] = useState('');
  const [authorizationError, setAuthorizationError] = useState('');
  const unauthorized = useCallback((message: string) => {setAuthorizationError(message); onUnauthorized?.(message);}, [onUnauthorized]);
  const query = new URLSearchParams({offset: String(offset), limit: '25'});
  if (periodId && ['usage-ledger', 'reserved-jobs'].includes(tab)) query.set('period_id', periodId);
  const {data, loading, error, reload} = useBillingResource<Page>(`/v1/admin/users/${encodeURIComponent(userId)}/${tab}?${query}`, unauthorized);
  const previousRevision = useRef(revision);
  useEffect(() => {if (previousRevision.current !== revision) {previousRevision.current = revision; void reload();}}, [revision, reload]);
  const navigate = (value: string, period = '') => {setTab(value); setOffset(0); setPeriodId(period);};
  return <section className="panel care-user-history" aria-labelledby="user-history-title" aria-busy={loading}>
    <div className="care-section-heading"><div><h3 id="user-history-title">历史额度与操作追溯</h3><p className="care-subtitle">从额度周期追溯扣页、预占与会员变更。</p></div><button className="secondary" disabled={loading} onClick={() => void reload()}>刷新历史</button></div>
    <div className="care-history-tabs" role="group" aria-label="历史类别">{Object.entries({'quota-periods': '额度周期', 'usage-ledger': '扣页账本', 'reserved-jobs': '预占任务', 'membership-operations': '会员操作'}).map(([value, title]) => <button key={value} onClick={() => navigate(value)} aria-pressed={tab === value}>{title}</button>)}</div>
    {periodId && <p className="care-history-scope"><span>已筛选额度桶 <code>{periodId}</code></span><button className="text-link" onClick={() => {setPeriodId(''); setOffset(0);}}>清除筛选</button></p>}
    {(error || authorizationError) && <p className="error" role="alert">{error || authorizationError}</p>}
    {!data ? <p role="status">{loading ? '正在读取历史…' : '无法读取历史，请刷新重试。'}</p> : <>
      {!data.items.length ? <div className="care-empty"><span aria-hidden="true">◇</span><div><strong>暂无符合条件的历史记录</strong><p>{periodId ? '此额度桶暂无记录，可清除筛选查看全部。' : '对应操作发生后，记录会显示在这里。'}</p></div></div> : tab === 'quota-periods' ? <Table heads={['模式 / 来源', '授予 / 已用 / 预占', '生效 / 到期', '追溯']}>{data.items.map(row => <tr key={row.id}>
        <td><strong>{label(row.mode)}</strong><small>{sources[row.source || ''] || label(row.source)}{row.note && ` · ${row.note}`}</small><code className="care-record-id">{row.id}</code></td><td><div className="care-quota-numbers"><span><b>{row.granted}</b><small>授予</small></span><span><b>{row.used}</b><small>已用</small></span><span><b>{row.reserved}</b><small>预占</small></span></div></td>
        <td><div className="care-period-dates"><HistoryTime value={row.starts_at} prefix="生效"/><HistoryTime value={row.expires_at} prefix="到期"/></div></td><td><div className="care-history-links"><button className="text-link" onClick={() => navigate('usage-ledger', row.id)}>查看账本</button><button className="text-link" onClick={() => navigate('reserved-jobs', row.id)}>查看预占</button></div>{row.billing_term_id && <small>支付授权期 <code className="care-record-id">{row.billing_term_id}</code></small>}</td></tr>)}</Table>
      : tab === 'usage-ledger' ? <Table heads={['时间 / 动作', '页数', '额度桶 / 任务', '备注']}>{data.items.map(row => <tr key={row.id}>
        <td><HistoryTime value={row.created_at}/><span className="care-inline-tag">{operations[row.kind || ''] || label(row.kind)}</span></td><td><strong className="care-number">{row.amount}</strong></td><td><span className="care-label">额度桶</span><code className="care-record-id">{row.period_id || '—'}</code>{row.job_id && <small><Jump view="tasks" params={{q: row.job_id}}>任务 <code>{row.job_id}</code></Jump></small>}</td><td className="care-note-cell">{row.note || '—'}</td></tr>)}</Table>
      : tab === 'reserved-jobs' ? <Table heads={['任务', '模式 / 状态', '预占页数', '受理时间 / 额度桶']}>{data.items.map(row => <tr key={row.id}>
        <td><Jump view="tasks" params={{q: row.id}}><code>{row.id}</code></Jump></td><td><strong>{label(row.mode)}</strong><small>{label(row.status)}</small></td><td><strong className="care-number">{row.quota_pages}</strong></td><td><HistoryTime value={row.created_at}/><code className="care-record-id">{row.quota_period_id}</code></td></tr>)}</Table>
      : <Table heads={['时间 / 操作人', '动作', '参数', '原因']}>{data.items.map(row => <tr key={row.id}>
        <td><HistoryTime value={row.created_at}/><small className="care-history-actor">{row.operator_name || '未记录处理人'}</small><code className="care-record-id">{row.operator_id}</code></td><td><strong>{operations[row.kind || ''] || row.kind}</strong>{row.details?.action && <small>{row.details.action === 'expire' ? '提前结束' : '开通 / 续期'}</small>}</td>
        <td className="care-operation-parameters">{row.details?.action === 'expire' ? <span className="care-subtitle">立即生效</span> : Object.entries(row.details || {}).filter(([key, value]) => !['note', 'action'].includes(key) && value != null).map(([key, value]) => <div key={key}><span>{({days: '天数', months: '月数', monthly_pages: '每月页数', pages: '页数', mode: '模式', kind: '额度类型', starts_at: '生效', expires_at: '到期', period_id: '额度桶'} as Record<string, string>)[key] || key}</span><b>{['mode', 'kind'].includes(key) ? label(String(value)) : ['starts_at', 'expires_at'].includes(key) ? time(String(value)) : String(value)}</b></div>)}</td><td className="care-note-cell">{row.details?.note || '—'}</td></tr>)}</Table>}
      {data.total > 0 && <Pagination total={data.total} count={data.items.length} offset={offset} next={data.next_offset} onPage={setOffset}/>}
    </>}
    <p className="panel-note">历史记录仅查询数据库。预占、扣减和释放分别保留；到期桶仍可能有在途预占任务。</p>
  </section>;
}
