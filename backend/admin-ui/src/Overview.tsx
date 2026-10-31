import type {Overview as OverviewData} from './types';
import {duration, Empty, href, Jump, label, number, Stat, Table, time} from './ui';
import {billingStatus, environmentName, money} from './billing';
import {EntityLink} from './EntityLink';
import {inboxLabels, inboxViews} from './Inbox';

export function Overview({data}: {data: OverviewData}) {
  const active = data.queues.reduce((sum, row) => sum + row.count, 0);
  const success = data.completed_24h.filter(row => ['succeeded', 'no_text'].includes(row.status)).reduce((sum, row) => sum + row.count, 0);
  const failed = data.completed_24h.filter(row => row.status === 'failed').reduce((sum, row) => sum + row.count, 0);
  const revenue = data.commerce.revenue_24h.map(row => money(row.amount, row.currency)).join(' / ');
  return <div className="overview-workspace">
    <div className="stats-grid business-stats">
      <a href={href('orders', {environment: 'live'})}><Stat title="近 24 小时实收原金额" value={revenue || '暂无收款'} note="正式订单 · 分币种 · 退款前金额"/></a>
      <a href={href('orders')}><Stat title="近 24 小时订单" value={number(data.commerce.orders_24h)} note={`${data.commerce.attention_orders} 笔异常或待核定 · 含测试订单`}/></a>
      <a href={href('feedback')}><Stat title="待处理反馈" value={number(data.inbox.total)} note="翻译、插件、卸载与网站适配" tint/></a>
      <a href={href('users')}><Stat title="注册用户" value={number(data.users.total)} note={`${number(data.users.submitted_24h)} 位近 24 小时提交过任务`}/></a>
    </div>
    <div className="overview-columns">
      <section className="panel overview-orders"><div className="panel-heading"><div><h2>最近订单</h2><p className="muted">从用户和购买内容开始核对</p></div><Jump view="orders">全部订单 →</Jump></div>
        {data.commerce.recent_orders.length ? <Table heads={['用户 / 产品', '金额', '状态', '时间']}>{data.commerce.recent_orders.map(order => <tr key={order.id}>
          <td><EntityLink kind="users" id={order.owner_id}>{order.owner_name}</EntityLink><small><a className="text-link" href={href('orders', {detail: order.id})}>{order.product_name}</a></small></td>
          <td className="numeric">{money(order.total, order.currency)}<small>{environmentName(order.environment)}</small></td><td><span className={`badge ${order.status === 'paid' ? 'good' : ['failed','unknown','disputed'].includes(order.status) ? 'warn' : ''}`}>{billingStatus(order.status)}</span></td><td>{time(order.created_at)}</td>
        </tr>)}</Table> : <Empty>暂无订单</Empty>}
      </section>
      <section className="panel overview-inbox"><div className="panel-heading"><div><h2>反馈待办</h2><p className="muted">新反馈会在右上角即时提醒</p></div><Jump view="feedback">进入收件箱 →</Jump></div>
        <div className="inbox-categories">{Object.entries(inboxLabels).map(([kind, title]) => <a key={kind} href={href(inboxViews[kind])}><span>{title}</span><b>{data.inbox.counts[kind] || 0}</b></a>)}</div>
        {data.recent_feedback.length ? <div className="feedback-preview">{data.recent_feedback.map(row => <a key={row.id} href={href(inboxViews[row.kind], {detail: row.id})}>
          <div><b>{row.name}</b><span className="badge">{inboxLabels[row.kind]}</span></div><p>{row.comment || '申请适配网站'}</p><small>{time(row.created_at)} · {row.status === 'received' ? '待处理' : '处理中'}</small>
        </a>)}</div> : <Empty>反馈已处理完毕</Empty>}
      </section>
    </div>
    <section className="panel running-summary"><div className="panel-heading"><div><h2>翻译服务</h2><p className="muted">当前在途 {number(active)} · 近 24 小时完成 {number(success)}</p></div><Jump view="tasks">查看任务 →</Jump></div>
      <div className="service-metrics"><Jump view="nodes">在线资源 <b>{data.nodes.online_enabled} / {data.nodes.total}</b></Jump><Jump view="tasks" params={{status: 'attention'}}>失败任务 <b>{failed}</b></Jump><Jump view="nodes">过期租约 <b>{data.leases.expired || 0}</b></Jump></div>
      <div className="queue-statuses">{data.queues.length ? data.queues.map(row => <a key={`${row.workflow_kind}:${row.status}`} href={href('tasks', {status: row.status, workflow_kind: row.workflow_kind})}>
        <span>{label(row.workflow_kind)} · {label(row.status)}</span><strong>{row.count}</strong>{row.status === 'queued' && <small>最早已等待 {duration(row.oldest_seconds)}</small>}
      </a>) : <p className="muted">当前没有在途任务。</p>}</div>
    </section>
  </div>;
}
