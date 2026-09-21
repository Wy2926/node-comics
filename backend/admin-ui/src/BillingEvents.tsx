import {useEffect, useRef, useState} from 'react';
import {ApiError, authError, errorText, request} from './api';
import {billingDate, billingEndpoint, billingStatus, billingTime as time, environmentName, eventStatus, providerName, type BillingEvent, type BillingEventDetail, type BillingPage} from './billing';
import {BillingDialog, useBillingResource} from './BillingShared';
import {Empty, href, Table} from './ui';

type Props = {params: URLSearchParams; onNavigate: (values: Record<string, string>) => void; onUnauthorized: (message: string) => void};
type RetryOperation = {body: {note: string; expected_attempts: number; operation_key: string}; done?: boolean};
const eventNames: Record<string, string> = {'refund.created': '退款已创建', 'dispute.created': '争议已创建',
  'checkout.completed': '结账已完成', 'subscription.paid': '订阅付款成功', 'subscription.active': '订阅已生效',
  'subscription.canceled': '订阅已取消', 'subscription.expired': '订阅已到期'};
const referenceNames: Record<string, string> = {transaction_id: '平台交易', subscription_id: '平台订阅', checkout_id: '平台结账', customer_id: '平台客户', order_id: '订单', refund_id: '退款', dispute_id: '争议'};

function EventDetail({id, onClose, onUnauthorized, onChanged}: {id: string; onClose: () => void; onUnauthorized: Props['onUnauthorized']; onChanged: () => Promise<void>}) {
  const {data, loading, error, reload} = useBillingResource<BillingEventDetail>(`${billingEndpoint}/events/${encodeURIComponent(id)}`, onUnauthorized);
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [actionError, setActionError] = useState('');
  const storageKey = `nc-admin-billing-event:${id}`;
  const [operation, setOperation] = useState<RetryOperation | undefined>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      return value?.body && typeof value.body.note === 'string' && Number.isInteger(value.body.expected_attempts)
        && typeof value.body.operation_key === 'string' ? value : undefined;
    } catch {return undefined;}
  });
  const save = (value: RetryOperation | undefined) => {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey);
    setOperation(value);
  };
  const pending = useRef(false);
  async function retry() {
    if (pending.current || operation?.done || (!operation && (!data || !note.trim() || error))) return;
    pending.current = true; setBusy(true); setNotice(''); setActionError('');
    try {
      const current = operation ?? {body: {note: note.trim(), expected_attempts: data!.event.attempts, operation_key: crypto.randomUUID()}};
      save(current);
      await request(`${billingEndpoint}/events/${encodeURIComponent(id)}/retry`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(current.body)});
      save({...current, done: true}); setNote(''); setNotice('已确认原重试请求受理。刷新可查看事件处理结果。'); await reload(); await onChanged();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) save(undefined);
      if (authError(failure)) onUnauthorized(errorText(failure)); else {setActionError(errorText(failure)); await reload();}
    }
    finally {pending.current = false; setBusy(false);}
  }
  const leaseActive = !!data && data.event.status === 'processing' && !!data.event.next_attempt_at && billingDate(data.event.next_attempt_at).getTime() > Date.now();
  return <BillingDialog title="支付事件详情" className="event-dialog" busy={busy} onClose={onClose}><div className="event-content" aria-busy={loading || busy}>
    <div className="billing-detail-toolbar"><code>{id}</code><button className="secondary" disabled={loading || busy} onClick={() => void reload()}>刷新详情</button></div>
    {error && <p className="error" role="alert">{error}</p>}{actionError && <p className="error" role="alert">{actionError}</p>}{notice && <p role="status" className="settings-notice">{notice}</p>}
    {!data ? <p className="loading">{loading ? '正在读取事件…' : '事件暂时不可用。'}</p> : <>
      <div className="event-summary"><div><h3>{eventNames[data.event.event_type] || data.event.event_type}</h3><p>{providerName(data.event.provider)} · {environmentName(data.event.environment)} · 已处理 {data.event.attempts} 次</p></div><span className={`badge ${data.event.error_code ? 'warn' : data.event.status === 'processed' ? 'good' : ''}`}>{eventStatus(data.event.status)}</span></div>
      {data.event.error_code && <div className="event-error"><strong>最近处理异常</strong><code>{data.event.error_code}</code><p>先核查渠道配置与关联订单，修复原因后再重试。</p></div>}
      <section className="event-section"><h3 className="detail-heading">处理时间</h3><dl className="detail-meta"><dt>发生时间</dt><dd>{time(data.event.occurred_at)}</dd><dt>接收时间</dt><dd>{time(data.event.received_at)}</dd><dt>完成时间</dt><dd>{time(data.event.processed_at)}</dd><dt>{leaseActive ? '处理租约截止' : '下次重试'}</dt><dd>{data.event.status === 'processed' ? '—' : time(data.event.next_attempt_at)}</dd><dt>最近手动重试</dt><dd>{time(data.event.last_retry_at)}</dd></dl></section>
      {operation ? <section className="event-action"><h3>重试操作回执</h3><p>原因：{operation.body.note}</p><p className="muted">原处理次数：{operation.body.expected_attempts}</p><p role="status">{operation.done ? '已确认操作受理。' : '原操作回包尚未确认，核实将使用原编号和原请求，不会重新创建重试操作。'}</p>{operation.done ? <button className="secondary" onClick={() => {save(undefined); setNotice('');}}>关闭回执</button> : <button className="primary" disabled={busy} onClick={() => void retry()}>{busy ? '正在核实…' : '重试并核实原操作'}</button>}</section> : data.event.status !== 'processed' && <form className="event-action" onSubmit={event => {event.preventDefault(); void retry();}}><h3>手动重试</h3><p className="muted">将既有事件重新排入核实队列，记录本次处理人和原因。每分钟最多手动重试一次。</p>{leaseActive && <p role="status" className="attention">事件正在处理中，请等待租约结束后刷新详情。</p>}<label>重试原因<textarea rows={3} value={note} maxLength={500} required disabled={busy || leaseActive} placeholder="记录已排查的问题、修复情况与本次重试原因" onChange={event => setNote(event.target.value)}/></label><button className="primary" disabled={busy || loading || leaseActive || !!error || !note.trim()}>{busy ? '正在提交…' : '排入重试队列'}</button></form>}
      <section className="event-section"><h3 className="detail-heading">关联订单 <span>{data.orders_total} 笔</span></h3>{data.orders.length ? <Table heads={['订单', '状态', '平台交易']}>{data.orders.map(order => <tr key={order.id}><td><a className="text-link" href={href('orders', {q: order.id})}>{order.id}</a></td><td>{billingStatus(order.status)}</td><td><code>{order.external_id || '—'}</code></td></tr>)}</Table> : <p className="muted">尚未绑定订单，请结合平台资源编号排查。</p>}{data.orders_total > data.orders.length && <p className="muted">仅显示最近 {data.orders.length} 笔，请到订单管理按订阅编号检索。</p>}</section>
      <details className="event-section"><summary>平台关联编号</summary><dl className="event-references"><div><dt>事件类型</dt><dd><code>{data.event.event_type}</code></dd></div><div><dt>平台资源</dt><dd><code>{data.event.resource_id}</code></dd></div>{Object.entries(data.references).map(([key, value]) => <div key={key}><dt>{referenceNames[key] || key}</dt><dd><code>{value}</code></dd></div>)}</dl></details>
    </>}
  </div></BillingDialog>;
}

export function BillingEventsPage({params, onNavigate, onUnauthorized}: Props) {
  const query = new URLSearchParams();
  for (const key of ['provider', 'environment', 'status', 'event_type', 'error_only', 'q', 'page', 'received_from', 'received_to']) if (params.get(key)) query.set(key, params.get(key)!);
  const {data, loading, error, reload} = useBillingResource<BillingPage<BillingEvent>>(`${billingEndpoint}/events?${query}`, onUnauthorized);
  const [detail, setDetail] = useState<string>();
  useEffect(() => {document.title = '支付事件 · Node Comics 管理后台';}, []);
  return <main id="main" tabIndex={-1} className="admin-surface payment-events">
    <div className="page-heading"><div><p className="eyebrow">PAYMENT EVENTS</p><h1>支付事件</h1><p className="muted">追踪验签通知、处理失败与重试状态。</p></div><button className="secondary" disabled={loading} onClick={() => void reload()}>刷新事件</button></div>
    <div className="status-tabs" role="group" aria-label="支付事件视图">{[['', '全部事件'], ['pending', '待处理'], ['processing', '处理中'], ['processed', '已处理']].map(([value, title]) => <button key={value} aria-pressed={(params.get('status') || '') === value && !params.get('error_only')} onClick={() => onNavigate({...Object.fromEntries(params), status: value, error_only: '', page: ''})}>{title}</button>)}<button aria-pressed={params.get('error_only') === 'true'} onClick={() => onNavigate({...Object.fromEntries(params), status: '', error_only: 'true', page: ''})}>仅看异常</button></div>
    <section className="filters"><form className="filter-form" key={params.toString()} onSubmit={event => {event.preventDefault(); onNavigate(Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, String(value).trim()]).filter(([, value]) => value)));}}>
      <label className="search-label">搜索<input name="q" defaultValue={params.get('q') || ''} maxLength={320} placeholder="事件 / 资源编号 / 错误代码"/></label><label>渠道<select name="provider" defaultValue={params.get('provider') || ''}><option value="">全部</option><option value="creem">Creem</option><option value="stripe">Stripe</option></select></label><label>环境<select name="environment" defaultValue={params.get('environment') || ''}><option value="">全部</option><option value="test">测试环境</option><option value="live">正式环境</option></select></label><label>状态<select name="status" defaultValue={params.get('status') || ''}><option value="">全部</option>{['pending', 'processing', 'processed'].map(value => <option key={value} value={value}>{eventStatus(value)}</option>)}</select></label><label>事件类型<input name="event_type" defaultValue={params.get('event_type') || ''} maxLength={80} placeholder="如 refund.created"/></label><label>异常<select name="error_only" defaultValue={params.get('error_only') || ''}><option value="">全部事件</option><option value="true">仅处理异常</option></select></label><div className="filter-actions"><button className="secondary" type="button" onClick={() => onNavigate({})}>重置</button><button className="primary">筛选</button></div>
    </form></section>
    {error && <p role="alert" className="error">{error}{data && ' 列表可能已过时。'}</p>}
    <section className="panel list-panel" aria-busy={loading}>{!data ? <p className="loading">{loading ? '正在读取事件…' : '事件暂时不可用。'}</p> : <>
      {!data.items.length ? <Empty>没有符合条件的支付事件</Empty> : <Table heads={['事件 / 资源', '渠道', '状态 / 异常', '尝试次数', '接收 / 处理时间', '操作']}>{data.items.map(event => <tr key={event.id}><td><strong>{eventNames[event.event_type] || event.event_type}</strong><small><code>{event.id}</code></small><small><code>{event.resource_id}</code></small></td><td>{providerName(event.provider)}<small>{environmentName(event.environment)}</small></td><td><span className={`badge ${event.error_code ? 'warn' : event.status === 'processed' ? 'good' : ''}`}>{eventStatus(event.status)}</span><small>{event.error_code || '—'}</small></td><td>{event.attempts}</td><td>{time(event.received_at)}<small>{time(event.processed_at)}</small></td><td><button className="text-link" onClick={() => setDetail(event.id)}>查看详情</button></td></tr>)}</Table>}
      <div className="pagination"><span>共 {data.total} 条事件</span><div><button className="secondary" disabled={loading || data.page <= 1} onClick={() => onNavigate({...Object.fromEntries(params), page: String(data.page - 1)})}>上一页</button><button className="secondary" disabled={loading || data.page * data.page_size >= data.total} onClick={() => onNavigate({...Object.fromEntries(params), page: String(data.page + 1)})}>下一页</button></div></div>
    </>}</section>
    {detail && <EventDetail key={detail} id={detail} onClose={() => setDetail(undefined)} onUnauthorized={onUnauthorized} onChanged={reload}/>}
  </main>;
}
