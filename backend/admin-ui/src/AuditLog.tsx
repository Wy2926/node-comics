import {Fragment, useState} from 'react';
import {Pagination, Table, time} from './ui';
import {ResourceError, useAdminResource, type DataPage} from './AdminResource';

const actions: Record<string, string> = {
  'node.create': '添加节点', 'node.configure': '修改节点配置', 'node.rotate_credential': '轮换节点凭据',
  'system_settings.update': '修改系统设置', 'text_provider.create': '添加文本供应商',
  'text_provider.update': '修改文本供应商', 'text_provider.toggle': '启停文本供应商', 'text_provider.default': '切换默认文本供应商',
  'image_provider.save': '保存图片供应商', 'image_provider.toggle': '启停图片供应商', 'image_provider.test': '提交图片测试',
  'job.reconcile': '核实翻译结果', 'feedback.review': '处理翻译反馈',
  'membership.extend': '开通或续期运营会员', 'membership.expire': '提前结束运营会员',
  'quota.compensate': '补偿当前额度', 'quota.grant': '赠送翻译额度',
  'billing.event.retry': '重新处理支付事件', 'billing.order.reconcile': '核实支付订单',
  'billing.order.reconcile_failed': '支付订单核实失败', 'billing.default_provider.update': '切换默认支付渠道',
  'billing.product.create': '创建会员产品', 'billing.revision.create': '创建权益版本',
  'billing.price.create': '创建价格', 'billing.price.status': '发布或停售价格',
  'billing.binding.create': '创建渠道绑定', 'billing.binding.status': '启停渠道绑定',
};
const targets: Record<string, string> = {user: '用户', feedback: '翻译反馈', job: '翻译任务', image_provider: '图片供应商',
  translation_provider: '文本供应商', compute_node: '计算节点', system_settings: '系统设置', quota_period: '额度周期',
  billing_order: '订单', billing_event: '支付事件', billing_settings: '支付设置', billing_plan: '会员产品',
  billing_plan_revision: '权益版本', billing_price: '价格', billing_price_binding: '渠道绑定'};
const fieldNames: Record<string, string> = {status: '状态', enabled: '启用', name: '名称', label: '显示名称',
  version: '版本', revision_id: '配置版本', model: '模型', base_url: '服务地址', attempts: '处理次数',
  free_daily_pages: '普通每日常规页数', plus_monthly_redraw_pages: '会员默认月重绘页数',
  free_scheduler_weight: '普通调度权重', plus_scheduler_weight: 'PLUS 调度权重', granted: '授予页数',
  used: '已使用', reserved: '预占', plus_expires_at: '会员到期', default_provider: '默认渠道'};
const values: Record<string, string> = {received: '待处理', reviewing: '处理中', resolved: '已解决', pending: '待处理',
  processing: '处理中', processed: '已处理', active: '生效中', archived: '已停用', true: '是', false: '否', '[redacted]': '已隐藏敏感内容'};
export function flat(value: unknown, prefix = '', depth = 0): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value) && depth < 5) {
    const entries = Object.entries(value);
    if (entries.length) return Object.fromEntries(entries.flatMap(([key, item]) => Object.entries(flat(item, prefix ? `${prefix}.${key}` : key, depth + 1))));
  }
  return prefix ? {[prefix]: value} : {};
}
export function changeText(value: unknown, present = true) {
  if (!present || value === undefined) return '未记录';
  if (value === null) return '空值';
  if (typeof value === 'object') return JSON.stringify(value);
  return values[String(value)] || String(value);
}
export function auditChanges(before: unknown, after: unknown) {
  const a = flat(before), b = flat(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(key => Object.hasOwn(a, key) !== Object.hasOwn(b, key) || JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .map(key => ({key, before: changeText(a[key], Object.hasOwn(a, key)), after: changeText(b[key], Object.hasOwn(b, key))}));
}
function Changes({before, after, details}: {before: unknown; after: unknown; details: unknown}) {
  const changes = auditChanges(before, after);
  return <><div className="audit-changes">{changes.length ? <Table heads={['变更项', '修改前', '修改后']}>
    {changes.slice(0,80).map(change => <tr key={change.key}><td>{fieldNames[change.key.split('.').pop()!] || change.key}</td><td>{change.before}</td><td>{change.after}</td></tr>)}
  </Table> : <p className="audit-empty">此操作没有可比较的字段变更，业务详情见完整记录。</p>}</div>
    <details><summary>查看完整记录{changes.length > 80 ? '（含其余变更）' : ''}</summary><pre className="admin-json">{JSON.stringify({修改前: before, 修改后: after, 详情: details}, null, 2)}</pre></details></>;
}

export function AuditLogPage({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  const [query, setQuery] = useState(new URLSearchParams());
  const [expanded, setExpanded] = useState<string>();
  const {data, error, busy, reload} = useAdminResource<DataPage>(`/v1/admin/audit?${query}`, onUnauthorized);
  return <main id="main" tabIndex={-1} className="admin-surface audit-page"><div className="page-heading"><div><p className="eyebrow">ADMINISTRATION HISTORY</p><h1>操作审计</h1>
    <p className="muted">查看管理员执行的业务操作、变更内容与原因。</p></div><button className="secondary" disabled={busy} onClick={reload}>刷新记录</button></div>
    <form className="filters filter-form" onSubmit={event => {event.preventDefault(); const next = new URLSearchParams();
      for (const [key, value] of new FormData(event.currentTarget)) if (String(value).trim()) {
        const text = String(value).trim(); next.set(key, key === 'created_from' || key === 'created_to' ? new Date(text).toISOString() : text);
      } if (next.toString() === query.toString()) reload(); else setQuery(next); setExpanded(undefined);}}>
      <label>操作人 ID<input name="actor_id" maxLength={36} placeholder="可按管理员编号筛选"/></label><label>操作类型<select name="action"><option value="">全部操作</option>{Object.entries(actions).map(([key,title])=><option key={key} value={key}>{title}</option>)}</select></label>
      <label>对象类型<select name="target_type"><option value="">全部对象</option>{Object.entries(targets).map(([key,title])=><option key={key} value={key}>{title}</option>)}</select></label><label>对象 ID<input name="target_id" maxLength={320} placeholder="任务、订单或用户编号"/></label>
      <label>开始时间<input name="created_from" type="datetime-local"/></label><label>结束时间<input name="created_to" type="datetime-local"/></label>
      <div className="filter-actions"><button className="secondary" type="reset" onClick={() => {setQuery(new URLSearchParams()); setExpanded(undefined);}}>重置</button><button className="primary">筛选</button></div></form>
    <ResourceError error={error} stale={!!data}/>{busy && <p role="status">正在读取审计记录…</p>}
    {data && <section className="panel"><div className="section-bar"><h2>操作记录<span className="section-count">{data.total} 条</span></h2><p>按发生时间倒序排列</p></div><Table heads={['时间 / 操作人', '操作 / 对象', '操作原因', '变更']}>
      {data.items.map(row => <Fragment key={String(row.id)}><tr><td>{time(String(row.created_at))}<small>{String(row.actor_name)}</small></td>
        <td><strong>{actions[String(row.action)] || String(row.action)}</strong><small>{targets[String(row.target_type)] || String(row.target_type)} · <code>{String(row.target_id)}</code></small></td>
        <td>{String(row.note || '—')}</td><td><button className="text-link" aria-expanded={expanded === row.id} aria-controls={`audit-${row.id}`} onClick={() => setExpanded(expanded === row.id ? undefined : String(row.id))}>{expanded === row.id ? '收起变更' : '查看变更内容'}</button></td></tr>
        {expanded === row.id && <tr className="audit-expanded" id={`audit-${row.id}`}><td colSpan={4}><Changes before={row.before} after={row.after} details={row.details}/><p className="muted">操作人编号：{String(row.actor_id)}</p></td></tr>}</Fragment>)}
    </Table>{!data.items.length && <p className="panel-note">没有符合条件的操作记录。</p>}
      <Pagination total={data.total} count={data.items.length} offset={Number(query.get('offset') || 0)} next={data.next_offset}
        onPage={offset => setQuery(new URLSearchParams({...Object.fromEntries(query), offset: String(offset)}))}/></section>}
    <p className="footnote">审计随业务事务保存，不提供修改或删除入口。供应商密钥、登录令牌和私有图片内容不在此展示。</p>
  </main>;
}
