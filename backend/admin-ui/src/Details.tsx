import type {Mode, TaskDetail as TaskData, UserDetail as UserData} from './types';
import {Badge, duration, Empty, Jump, label, number, Stat, Table, time} from './ui';
import {MembershipActions} from './MembershipActions';

export function TaskDetail({job: j}: {job: TaskData}) {
  const final = j.completed_by;
  return <>
    <div className="detail-summary"><div><code>{j.id}</code><p>{j.owner_name} · {label(j.mode)} · {j.target_language}{j.cache_hit && ' · 缓存命中'}</p></div><Badge value={j.status}/></div>
    <div className="detail-stats"><Stat title="总耗时" value={duration(j.elapsed_seconds)} note="从创建到结束 / 当前"/>
      <Stat title="首次等待" value={duration(j.initial_wait_seconds)} note="创建至首次领取"/>
      <Stat title="执行占用" value={duration(j.execution_seconds)} note="并行阶段合并"/>
      <Stat title="非执行时间" value={duration(j.non_execution_seconds)} note="上传、排队与阶段间等待"/></div>
    <dl className="detail-meta"><dt>创建时间</dt><dd>{time(j.created_at)}</dd><dt>结束时间</dt><dd>{time(j.completed_at)}</dd>
      <dt>交付节点</dt><dd>{final?.name || (j.cache_hit ? '缓存复用，无新增执行' : '—')}</dd>
      <dt>交付执行机 / 进程</dt><dd>{final ? final.executor_id || '未记录' : '—'}</dd>
      <dt>额度结算</dt><dd>{label(j.settlement)} · {j.quota_pages} 页</dd><dt>供应商</dt><dd>{j.provider?.id || '—'}</dd></dl>
    {j.error_code && <p className="error">{j.error_message && <>{j.error_message}<br/></>}错误代码：{j.error_code}</p>}
    {j.expired_leases > 0 && <p className="attention">{j.expired_leases} 个租约已过期，等待回收。</p>}
    <h3 className="detail-heading">阶段进度</h3><div className="stage-flow">{j.stages.length ? j.stages.map(s =>
      <div key={s.name}><b>{label(s.name)}</b><Badge value={s.status}/><small>已领取 {s.attempts} 次</small></div>) : <p className="muted">尚无执行阶段</p>}</div>
    <h3 className="detail-heading">执行履历 <span>{j.executions.length} 次</span></h3>
    {j.executions.length ? <Table heads={['阶段 / 代次', '节点 / 执行机', '开始 / 结束', '占用时长', '结果']}>
      {j.executions.map(e => <tr key={e.id}><td>{label(e.stage)}<small>第 {e.generation} 代 · {label(e.priority)}</small></td>
        <td>{e.node_name}<small>{e.executor_id || '执行机未记录'}</small></td>
        <td>{time(e.started_at)}<small>{e.completed_at ? time(e.completed_at) : e.outcome === 'expired' ? `过期于 ${time(e.expires_at)}` : '尚未结束'}</small></td>
        <td className="numeric">{duration(e.seconds)}</td><td><Badge value={e.outcome}/></td></tr>)}
    </Table> : <Empty>{j.cache_hit ? '此任务复用已有结果' : '尚无执行记录'}</Empty>}
    <p className="panel-note">阶段占用来自持久化租约，包含执行期间的网络与存储操作。多阶段并行时，各阶段之和 {duration(j.worker_seconds)} 可大于合并后的执行占用。</p>
    {j.text_calls.length > 0 && <><h3 className="detail-heading">文本调用计量</h3><p className="muted">合计 ¥{(j.text_cost_micros / 1000000).toFixed(6)}，包含估算或未知消耗的预占。成本仅计量，不限制文本调用；次数、时限与限流仍生效。</p>
      <Table heads={['模型 / 供应商', '分组 / 次数', '耗时', '成本记录', '结果']}>{j.text_calls.map(c =>
        <tr key={c.id}><td>{c.model}<small>{c.provider_id}</small></td><td>{c.group} / {c.sequence}</td><td>{duration(c.seconds)}</td>
          <td>¥{(c.accounted_micros / 1000000).toFixed(6)}<small>{label(c.cost_state)}</small></td><td>{c.error_code || '—'}</td></tr>)}</Table></>}
    <p className="footnote">快照时间 {time(j.generated_at)} · 详情打开时暂停列表自动刷新</p>
  </>;
}
export function UserDetail({user: u, onChanged}: {user: UserData; onChanged: () => void}) {
  const e = u.entitlements;
  const buckets = Object.values(e.modes).flatMap(m => m.quota?.buckets || []);
  return <><div className="detail-summary"><div><h3>{u.name}</h3><code>{u.id}</code></div><span className="badge accent">{e.plan === 'plus' ? 'PLUS' : '普通'}</span></div>
    <dl className="detail-meta"><dt>注册时间</dt><dd>{time(u.created_at)}</dd><dt>会员到期</dt><dd>{time(e.plus_expires_at)}</dd>
      <dt>每模式在途容量</dt><dd>{e.queue_capacity} 页</dd><dt>每模式实时名额</dt><dd>{e.realtime_slots} 页</dd></dl>
    <div className="queue-grid">{(['classic', 'redraw'] as Mode[]).map(mode => {
      const m = e.modes[mode], q = m.quota;
      return <section className="panel" key={mode}><h3>{label(mode)}</h3><p>{m.unlimited ? '不限量' : !m.allowed ? '当前无使用权益' : `可用 ${number(q?.available)} 页`}</p>
        {q && <dl className="node-info"><dt>本期已用</dt><dd>{number(q.used)} 页</dd><dt>在途预占</dt><dd>{number(q.reserved)} 页</dd>
          <dt>额度合计</dt><dd>{number(q.granted)} 页</dd><dt>下次重置</dt><dd>{time(q.resets_at)}</dd></dl>}
        <p className="panel-note">队列{u.queues.some(r => r.mode === mode && r.paused) ? '已暂停' : '正常'}</p></section>;
    })}</div>
    <MembershipActions key={u.id} user={u} onChanged={onChanged}/>
    <h3 className="detail-heading">赠送额度（按生效时间，最多 50 笔）</h3>
    {u.grants.length ? <Table heads={['类型 / 备注', '授予 / 已用 / 预占', '生效 / 到期']}>{u.grants.map(b => <tr key={b.id}>
      <td>{label(b.mode)}<small>{b.note}</small></td><td>{b.granted} / {b.used} / {b.reserved}</td>
      <td>{time(b.starts_at)}<small>{time(b.expires_at)}</small></td></tr>)}</Table> : <Empty>暂无赠送额度</Empty>}
    <h3 className="detail-heading">当前有效额度明细</h3>
    {buckets.length ? <Table heads={['类型', '授予 / 已用 / 预占', '到期']}>{buckets.map(b => <tr key={b.id}>
      <td>{label(b.mode)} · {({daily: '每日额度', membership: '会员额度', grant: '赠送额度'} as Record<string, string>)[b.source] || b.source}</td>
      <td>{b.granted} / {b.used} / {b.reserved}</td><td>{time(b.expires_at)}</td></tr>)}</Table> : <Empty>暂无有限页数额度</Empty>}
    <p><Jump view="tasks" params={{owner_id: u.id}}>查看该用户全部任务 ↗</Jump></p>
  </>;
}
