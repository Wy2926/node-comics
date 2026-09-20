import {useEffect, useRef, useState} from 'react';
import {authError, errorText, request} from './api';
import {billingEndpoint, billingStatus, billingTime as time, environmentName, intervalName, money, orderKind, providerName, type BillingOrderDetail, type BillingOrderPage} from './billing';
import {BillingBadge, BillingDialog, useBillingResource} from './BillingShared';
import {Empty, href, Table} from './ui';

function OrderDetail({id, onClose, onUnauthorized, onChanged}: {id: string; onClose: () => void; onUnauthorized: (message: string) => void; onChanged: () => Promise<void>}) {
  const {data, loading, error, reload} = useBillingResource<BillingOrderDetail>(`${billingEndpoint}/orders/${encodeURIComponent(id)}`, onUnauthorized);
  const [reconciling, setReconciling] = useState(false), [actionError, setActionError] = useState(''), [notice, setNotice] = useState(''), [sessionId, setSessionId] = useState('');
  const actionPending = useRef(false);
  async function reconcile() {
    if (loading || actionPending.current) return;
    actionPending.current = true; setReconciling(true); setActionError(''); setNotice('');
    try {
      const result = await request<{order_id: string; status: string}>(`${billingEndpoint}/orders/${encodeURIComponent(id)}/reconcile`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({session_id: sessionId.trim() || null})});
      setNotice(`平台状态已核实：${billingStatus(result.status)}。`); setSessionId(''); await reload(); await onChanged();
    } catch (failure) {if (authError(failure)) onUnauthorized(errorText(failure)); else setActionError(errorText(failure));}
    finally {actionPending.current = false; setReconciling(false);}
  }
  return <BillingDialog title="订单详情" onClose={onClose} busy={reconciling}><div className="billing-order-detail" aria-busy={loading || reconciling}>
    <div className="billing-detail-toolbar"><code>{id}</code><div className="provider-actions"><button className="secondary" disabled={loading || reconciling} onClick={() => void reload()}>{loading ? '正在刷新…' : '刷新详情'}</button><button className="secondary" disabled={!data || loading || reconciling || !!error} onClick={() => void reconcile()}>{reconciling ? '正在核实…' : '核实平台状态'}</button></div></div>
    {notice && <p className="settings-notice" role="status">{notice}</p>}{actionError && <p className="error" role="alert">{actionError} 请核对平台记录后重试。</p>}
    {error && <div className="error" role="alert">{error} 请刷新重试。{data && '当前详情可能已过时。'}</div>}
    {!data ? <p className="loading" role="status">{loading ? '正在读取订单…' : '暂时无法读取订单详情。'}</p> : <>
      <div className="detail-summary"><div><h3>{data.order.product_name || '订阅订单'} · {intervalName(data.order.interval)}</h3><p>{data.order.owner_name} · {providerName(data.order.provider)} · {environmentName(data.order.environment)}</p></div><BillingBadge status={data.order.status}/></div>
      <div className="billing-order-amount"><strong>{money(data.order.total, data.order.currency)}</strong><span>{orderKind(data.order.kind)}</span></div>
      <dl className="detail-meta"><dt>创建时间</dt><dd>{time(data.order.created_at)}</dd><dt>最近更新</dt><dd>{time(data.order.updated_at)}</dd><dt>支付时间</dt><dd>{time(data.order.paid_at)}</dd><dt>税前金额</dt><dd>{money(data.order.subtotal, data.order.currency)}</dd><dt>用户</dt><dd><a className="text-link" href={href('users', {q: data.order.owner_id})}>{data.order.owner_name}</a><small className="billing-block"><code>{data.order.owner_id}</code></small></dd><dt>平台订单编号</dt><dd><code>{data.order.external_id || '—'}</code></dd><dt>本地价格编号</dt><dd><code>{data.order.price_id || '—'}</code></dd><dt>渠道关联编号</dt><dd><code>{data.order.binding_id || '—'}</code></dd></dl>
      {data.order.error_code && <p className="error">订单异常：{data.order.error_code}</p>}
      {data.order.kind === 'initial' && data.order.status === 'unknown' && !data.checkout?.session_id && <div className="billing-reconcile"><label>平台结账编号（可选）<input value={sessionId} disabled={reconciling} maxLength={255} autoComplete="off" placeholder={data.order.provider === 'creem' ? 'ch_…' : 'cs_…'} onChange={event => setSessionId(event.target.value)}/></label><p className="muted">如果平台已创建结账，请填写对应编号后点击“核实平台状态”。系统会核对归属并恢复订单，不会重新发起付款。</p></div>}
      <h3 className="detail-heading">订单流转 <span>{data.transitions.length} 条记录</span></h3>
      {data.transitions.length ? <ol className="billing-timeline">{data.transitions.map(transition => <li key={transition.id}><div className="billing-timeline-heading"><strong>{transition.from_status ? `${billingStatus(transition.from_status)} → ` : ''}{billingStatus(transition.to_status)}</strong><time dateTime={transition.created_at}>{time(transition.created_at)}</time></div><p>{({checkout: '发起结账', checkout_sync: '结账状态同步', checkout_error: '结账失败', subscription_sync: '订阅状态同步', invoice_sync: '账单状态同步', transaction_sync: '交易状态同步', refund_sync: '退款状态同步', webhook: '平台通知', reconcile: '订单核对', system: '系统处理', admin: '后台操作'} as Record<string, string>)[transition.source] ?? transition.source}</p>{Object.entries(transition.detail ?? {}).map(([key, value]) => <p className="muted" key={key}>{({event_type: '事件类型', error_code: '异常代码', reason: '原因', subscription_status: '订阅状态', invoice_id: '账单编号', checkout_id: '结账编号'} as Record<string, string>)[key] ?? key}：{typeof value === 'string' ? value : JSON.stringify(value)}</p>)}{transition.event_id && <small>平台事件 <code>{transition.event_id}</code></small>}</li>)}</ol> : <p className="muted">暂无流转记录。</p>}
      <h3 className="detail-heading">最近支付通知 <span>{data.events_total ?? data.events?.length ?? 0} 条记录</span></h3>
      {data.events_total > (data.events?.length ?? 0) && <p className="muted">仅展示最近 {data.events_limit} 条通知，按接收时间从新到旧排列。</p>}
      {data.events?.length ? <Table heads={['事件 / 平台编号', '处理状态', '处理次数', '发生 / 接收时间', '处理 / 下次重试']}>{data.events.map(event => <tr key={event.id}>
        <td>{event.event_type}<small><code>{event.id}</code></small></td><td><span className={`badge ${event.status === 'processed' ? 'good' : event.error_code ? 'warn' : ''}`}>{({pending: '待处理', processing: '处理中', processed: '已处理', failed: '处理失败', ignored: '已忽略'} as Record<string, string>)[event.status] ?? event.status}</span>{event.error_code && <small className="billing-error-code">{event.error_code}</small>}</td><td>{event.attempts} 次</td><td>{time(event.occurred_at)}<small>{time(event.received_at)}</small></td><td>{time(event.processed_at)}<small>{!['processed', 'ignored'].includes(event.status) && event.next_attempt_at ? `重试 ${time(event.next_attempt_at)}` : '—'}</small></td>
      </tr>)}</Table> : <p className="muted">尚未收到关联的支付平台通知。</p>}
      <h3 className="detail-heading">结账信息</h3>{data.checkout ? <><dl className="detail-meta"><dt>结账状态</dt><dd>{billingStatus(data.checkout.status)}</dd><dt>首次试用</dt><dd>{data.checkout.trial ? '是' : '否'}</dd><dt>结账编号</dt><dd><code>{data.checkout.id}</code></dd><dt>平台结账编号</dt><dd><code>{data.checkout.session_id || '—'}</code></dd><dt>发起时间</dt><dd>{time(data.checkout.created_at)}</dd><dt>过期时间</dt><dd>{time(data.checkout.expires_at)}</dd></dl>{data.checkout.error_code && <p className="error">结账异常：{data.checkout.error_code}</p>}</> : <p className="muted">此订单未关联结账会话。</p>}
      <h3 className="detail-heading">订阅与权益</h3>{data.subscription ? <dl className="detail-meta"><dt>订阅状态</dt><dd><BillingBadge status={data.subscription.status} subscription/></dd><dt>订阅编号</dt><dd><code>{data.subscription.id}</code></dd><dt>下次扣款</dt><dd>{time(data.subscription.next_billed_at)}</dd><dt>计划取消</dt><dd>{time(data.subscription.cancel_at)}</dd><dt>试用周期</dt><dd>{data.subscription.trial_starts_at ? `${time(data.subscription.trial_starts_at)} — ${time(data.subscription.trial_ends_at)}` : '—'}</dd><dt>付费周期</dt><dd>{data.subscription.paid_starts_at ? `${time(data.subscription.paid_starts_at)} — ${time(data.subscription.paid_ends_at)}` : '—'}</dd></dl> : <p className="muted">尚未关联订阅。</p>}
      {data.price && <p className="billing-detail-benefits">购买权益：每月 {data.price.monthly_redraw_pages} 页重绘，常规翻译不限量。{data.price.interval === 'year' && '年付额度按月发放。'}首次试用 {data.price.trial_days} 天 / {data.price.trial_redraw_pages} 页。</p>}
    </>}
  </div></BillingDialog>;
}

export function BillingOrdersPage({params, onNavigate, onUnauthorized}: {params: URLSearchParams; onNavigate: (values: Record<string, string>) => void; onUnauthorized: (message: string) => void}) {
  const query = new URLSearchParams();
  for (const key of ['provider', 'environment', 'status', 'owner_id', 'q', 'created_from', 'created_to', 'page']) if (params.get(key)) query.set(key, params.get(key)!);
  query.set('page_size', '30');
  const {data, loading, error, reload} = useBillingResource<BillingOrderPage>(`${billingEndpoint}/orders?${query}`, onUnauthorized);
  const [detail, setDetail] = useState<string>();
  const [filterError, setFilterError] = useState('');
  useEffect(() => {document.title = '订单管理 · Node Comics 管理后台';}, []);
  const navigate = (values: Record<string, string>) => {if (href('orders', values) === location.hash) void reload(); else onNavigate(values);};
  const localDate = (value: string | null) => {if (!value) return ''; const date = new Date(value); if (!Number.isFinite(date.getTime())) return ''; return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);};
  return <main id="main" tabIndex={-1} className="billing-orders">
    <div className="page-heading"><div><p className="eyebrow">PAYMENTS & ORDERS</p><h1>订单管理</h1><p className="muted">查看各支付渠道的全部订单、支付结果、订阅状态和流转记录。</p></div><button className="secondary" disabled={loading} onClick={() => void reload()}>{loading ? '正在刷新…' : '刷新订单'}</button></div>
    <section className="filters" aria-label="订单筛选"><form className="filter-form" key={params.toString()} onSubmit={event => {event.preventDefault(); setFilterError(''); const values: Record<string, string> = {}; for (const [key, value] of new FormData(event.currentTarget)) {const text = String(value).trim(); if (text) values[key] = ['created_from', 'created_to'].includes(key) ? new Date(text).toISOString() : text;} if (values.created_from && values.created_to && values.created_from > values.created_to) {setFilterError('结束时间不能早于开始时间。'); return;} if (params.has('owner_id')) values.owner_id = params.get('owner_id')!; navigate(values);}}>
      <label className="search-label">搜索<input name="q" maxLength={120} defaultValue={params.get('q') ?? ''} placeholder="订单 / 平台编号 / 用户"/></label>
      <label>支付渠道<select name="provider" defaultValue={params.get('provider') ?? ''}><option value="">全部渠道</option><option value="stripe">Stripe</option><option value="creem">Creem</option></select></label>
      <label>订单状态<select name="status" defaultValue={params.get('status') ?? ''}><option value="">全部状态</option>{['creating', 'pending', 'processing', 'unknown', 'trialing', 'paid', 'failed', 'expired', 'canceled', 'refunded', 'partially_refunded', 'disputed'].map(status => <option key={status} value={status}>{billingStatus(status)}</option>)}</select></label>
      <label>支付环境<select name="environment" defaultValue={params.get('environment') ?? ''}><option value="">全部环境</option><option value="test">测试环境</option><option value="live">正式环境</option></select></label>
      <label>创建时间从<input name="created_from" type="datetime-local" defaultValue={localDate(params.get('created_from'))}/></label><label>创建时间至<input name="created_to" type="datetime-local" defaultValue={localDate(params.get('created_to'))}/></label>
      <button className="primary">筛选</button><button className="secondary" type="button" onClick={() => navigate({})}>重置</button>
    </form>{filterError && <p className="error" role="alert">{filterError}</p>}{params.has('owner_id') && <span className="scope-chip">用户：{params.get('owner_id')}</span>}</section>
    {error && <div className="error" role="alert">{error} {data ? '当前订单列表可能已过时。' : '请刷新订单重试。'}</div>}
    <section className="panel list-panel" aria-label="订单列表" aria-busy={loading}>{!data ? <p className="loading" role="status">{loading ? '正在读取订单…' : '暂时无法读取订单。'}</p> : <>
      {!data.items.length ? <Empty>{query.has('q') || query.has('status') || query.has('provider') || query.has('created_from') || query.has('created_to') ? '没有符合筛选条件的订单' : '暂无订单'}</Empty> : <Table heads={['订单 / 用户', '产品 / 周期', '支付渠道', '金额', '状态', '创建 / 更新时间', '操作']}>{data.items.map(order => <tr key={order.id}>
        <td><button className="text-link billing-order-link" onClick={() => setDetail(order.id)}>{order.id}</button><small>{order.owner_name}</small>{order.external_id && <small>平台 <code>{order.external_id}</code></small>}</td>
        <td><b>{order.product_name || '订阅订单'}</b><small>{intervalName(order.interval)} · {orderKind(order.kind)}</small></td><td>{providerName(order.provider)}<small>{environmentName(order.environment)}</small></td><td className="numeric">{money(order.total, order.currency)}</td>
        <td><BillingBadge status={order.status}/>{order.error_code && <small className="billing-error-code">{order.error_code}</small>}</td><td>{time(order.created_at)}<small>{time(order.updated_at)}</small></td><td><button className="text-link" onClick={() => setDetail(order.id)} aria-label={`查看订单 ${order.id}`}>查看流转</button></td>
      </tr>)}</Table>}
      <div className="pagination"><span>共 {data.total.toLocaleString('zh-CN')} 笔订单{data.items.length > 0 && ` · 第 ${(data.page - 1) * data.page_size + 1}–${(data.page - 1) * data.page_size + data.items.length} 笔`}</span><div><button className="secondary" disabled={loading || data.page <= 1} onClick={() => navigate({...Object.fromEntries(params), page: String(data.page - 1)})}>上一页</button><button className="secondary" disabled={loading || data.page * data.page_size >= data.total} onClick={() => navigate({...Object.fromEntries(params), page: String(data.page + 1)})}>下一页</button></div></div>
    </>}</section><p className="footnote billing-footnote">时间按浏览器本地时区显示。订单详情保留支付平台事件与处理状态，订阅续费分别记录为订单。</p>
    {detail && <OrderDetail key={detail} id={detail} onClose={() => setDetail(undefined)} onUnauthorized={onUnauthorized} onChanged={reload}/>}
  </main>;
}
