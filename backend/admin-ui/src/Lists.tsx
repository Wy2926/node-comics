import type {AdminUser, Node, Nodes as NodesData, Task} from './types';
import {Badge, duration, Empty, Jump, label, number, Table, time} from './ui';

export function Tasks({items, onTask}: {items: Task[]; onTask: (id: string) => void}) {
  if (!items.length) return <Empty>没有符合条件的任务</Empty>;
  return <Table heads={['任务 / 提交时间', '用户', '模式 / 优先级', '状态 / 阶段', '总耗时 / 执行占用', '执行节点', '操作']}>
    {items.map(j => <tr key={j.id}>
      <td><code title={j.id}>{j.id.slice(0, 8)}</code><small>{time(j.created_at)}</small></td>
      <td><Jump view="tasks" params={{owner_id: j.owner_id}}>{j.owner_name}</Jump></td>
      <td>{label(j.mode)}<small>{j.cache_hit ? '缓存命中' : label(j.priority)}</small></td>
      <td><Badge value={j.status}/><small>{label(j.phase)}{j.expired_leases > 0 && ' · 租约待回收'}</small></td>
      <td className="numeric">{duration(j.elapsed_seconds)}<small>执行 {duration(j.execution_seconds)}</small></td>
      <td>{j.completed_by?.name || j.running_nodes.join('、') || j.nodes.map(n => n.name).join('、') || '—'}
        <small>{j.completed_by ? '交付节点' : j.running_nodes.length ? '当前执行' : j.nodes.length ? '曾参与执行' : j.cache_hit ? '缓存复用' : '尚无执行记录'}</small></td>
      <td><button className="text-link" onClick={() => onTask(j.id)}>查看详情</button></td>
    </tr>)}
  </Table>;
}
export function Users({items, onUser}: {items: AdminUser[]; onUser: (id: string) => void}) {
  if (!items.length) return <Empty>没有符合条件的用户</Empty>;
  return <Table heads={['用户', '会员 / 角色', '当前在途', '累计任务 / 完成', '最近提交', '注册时间', '操作']}>
    {items.map(u => <tr key={u.id}>
      <td><b>{u.name}</b><small><code title={u.id}>{u.id.slice(0, 8)}</code></small></td>
      <td><span className={`badge ${u.plan === 'plus' ? 'accent' : ''}`}>{u.plan === 'plus' ? 'PLUS' : '普通'}</span>
        <small>{u.role === 'admin' ? '管理员' : '读者'}{u.plan === 'plus' && ` · 到期 ${time(u.plus_expires_at)}`}</small></td>
      <td><Jump view="tasks" params={{owner_id: u.id, status: 'active'}}>{number(u.active_jobs)}</Jump></td>
      <td>{number(Object.values(u.jobs).reduce((s, v) => s + v, 0))} / {number((u.jobs.succeeded || 0) + (u.jobs.no_text || 0))}<small>失败 {number(u.jobs.failed)}</small></td>
      <td>{time(u.last_submitted_at)}</td><td>{time(u.created_at)}</td>
      <td><button className="text-link" onClick={() => onUser(u.id)}>查看权益</button></td>
    </tr>)}
  </Table>;
}
export function Nodes({data, onConfigure}: {data: NodesData; onConfigure: (node: Node) => void}) {
  if (!data.items.length) return <Empty>尚未注册计算节点</Empty>;
  return <><div className="node-grid">{data.items.map(n => {
    const completed = n.completed_24h.reduce((s, r) => s + r.count, 0);
    const success = n.completed_24h.filter(r => r.outcome === 'succeeded').reduce((s, r) => s + r.count, 0);
    const average = completed ? n.completed_24h.reduce((s, r) => s + r.count * r.avg_seconds, 0) / completed : null;
    return <article className="panel node-card" key={n.id}>
      <div className="panel-heading"><span className="node-symbol" aria-hidden="true">▦</span><span className={`badge ${n.online && n.enabled ? 'good' : 'warn'}`}>{n.enabled ? n.online ? '在线' : '离线' : '已停用'}</span></div>
      <h2>{n.name}</h2><p className="muted">{n.kind === 'control_pool' ? '控制资源池' : '图像计算节点'} · {n.device}</p>
      <div className="tags">{n.capabilities.map(s => <Badge key={s} value={s}/>)}</div>
      <div className="capacity"><span>执行位占用</span><strong>{n.occupied} / {n.capacity}</strong></div>
      <progress max={Math.max(n.capacity, n.occupied, 1)} value={n.occupied} aria-label={`${n.name}执行位占用`}/>
      <p className="panel-note">{n.running} 个有效租约 · {n.expired_leases} 个过期待回收</p>
      <dl className="node-info"><dt>资源 ID</dt><dd>{n.resource_id}</dd><dt>引擎版本</dt><dd>{n.engine_version}</dd>
        {n.kind !== 'control_pool' && <><dt>配置同步</dt><dd>{n.config_error ? '应用失败 · ' + n.config_error : n.config_version === n.applied_config_version ? `已应用 v${n.config_version}` : `等待应用 v${n.config_version}（当前 v${n.applied_config_version}）`}</dd>
          <dt>支持语言</dt><dd>{n.supported_languages.join(' / ') || '等待节点报告'}</dd></>}
        <dt>最后心跳</dt><dd>{time(n.heartbeat_at)}</dd><dt>心跳间隔</dt><dd>{duration(n.heartbeat_age_seconds)}</dd>
        <dt>24 小时完成阶段</dt><dd>{number(success)} 成功 / {number(completed - success)} 其他</dd><dt>平均阶段占用</dt><dd>{duration(average)}</dd></dl>
      <Jump view="tasks" params={{node_id: n.id}}>查看参与任务 ↗</Jump>
      <button className="secondary" onClick={() => onConfigure(n)}>{n.kind === 'control_pool' ? '配置执行位' : '配置节点'}</button>
    </article>;
  })}</div><p className="footnote">超过 {data.timeout_seconds} 秒未报告心跳视为离线。过期租约在回收前仍占容量；阶段完成数包含上传校验与重试，不等于翻译页数。</p></>;
}
