import type {Overview as OverviewData} from './types';
import {Badge, duration, Empty, href, Jump, label, number, Stat, Table} from './ui';

export function Overview({data}: {data: OverviewData}) {
  const queues = data.queues;
  const count = (status: string) => queues.filter(q => q.status === status).reduce((s, q) => s + q.count, 0);
  const active = queues.reduce((s, q) => s + q.count, 0);
  const success = data.completed_24h.filter(s => ['succeeded', 'no_text'].includes(s.status)).reduce((sum, s) => sum + s.count, 0);
  const failed = data.completed_24h.filter(s => s.status === 'failed').reduce((sum, s) => sum + s.count, 0);
  const oldest = Math.max(0, ...queues.filter(q => q.status === 'queued').map(q => q.oldest_seconds));
  const inactiveNodes = data.nodes.total - data.nodes.online_enabled;
  return <>
    <div className="stats-grid">
      <Stat title="当前在途" value={number(active)} note="含上传、排队、执行与待核实" tint/>
      <Stat title="排队等待" value={number(count('queued'))} note={`最早提交已等待 ${duration(oldest)}`}/>
      <Stat title="正在执行" value={number(data.leases.running)} note="个有效阶段租约"/>
      <Stat title="近 24 小时完成" value={number(success)} note={`${number(failed)} 个任务失败 · 含无文字结果`}/>
    </div>
    {!!(count('outcome_unknown') || data.leases.expired || inactiveNodes) && <div className="attention"><b>需要关注</b>
      {!!count('outcome_unknown') && <Jump view="tasks" params={{status: 'outcome_unknown'}}>{count('outcome_unknown')} 个任务结果待核实</Jump>}
      {!!data.leases.expired && <Jump view="nodes">{data.leases.expired} 个租约过期待回收</Jump>}
      {!!inactiveNodes && <Jump view="nodes">{inactiveNodes} 个节点或资源池离线 / 停用</Jump>}
    </div>}
    <div className="section-heading"><div><h2>翻译队列</h2><p>按任务类型查看积压；单图一页一任务，整本文件按一个任务统计。</p></div><Jump view="tasks" params={{status: 'active'}}>查看全部在途 ↗</Jump></div>
    <div className="queue-grid">{(['image', 'document'] as const).map(kind => {
      const rows = queues.filter(q => (q.workflow_kind || 'image') === kind);
      const total = rows.reduce((s, r) => s + r.count, 0);
      const sum = (test: (row: typeof rows[number]) => boolean) => rows.filter(test).reduce((s, r) => s + r.count, 0);
      return <section className="panel queue-panel" key={kind}>
        <div className="panel-heading"><div className="mode-title"><span className="mode-icon classic">文</span>
          <div><h3>{label(kind)}</h3><span className="muted">{kind === 'image' ? 'OCR → 翻译 / 修复 → 嵌字' : 'R2 → OCR 汇总 → 一次翻译 → ZIP'}</span></div></div><b>{number(total)} <small>个任务在途</small></b></div>
        <div className="queue-counts">{(kind === 'image' ? ['awaiting_upload', 'validating_upload', 'queued', 'running', 'outcome_unknown'] : ['uploading', 'preflight', 'awaiting_quota', 'queued', 'running', 'outcome_unknown']).map(status =>
          <a href={href('tasks', {workflow_kind: kind, status})} key={status}><span>{label(status)}</span><strong>{number(sum(r => r.status === status))}</strong></a>)}</div>
      </section>;
    })}</div>
    <div className="bottom-grid"><section className="panel"><div className="panel-heading"><div><h2>阶段积压</h2><p className="muted">待执行包含暂不可调度阶段；阶段数可多于页数。</p></div></div>
      <Table heads={['阶段', '待执行', '执行中', '等待依赖']}>{['validate_upload', 'page', 'analyze', 'text', 'inpaint', 'render', 'doc_prepare', 'doc_ocr', 'doc_text', 'doc_render', 'doc_zip'].map(name => <tr key={name}><td>{label(name)}</td>
        {['ready', 'running', 'waiting'].map(status => <td key={status} className="numeric">{number(data.stages.filter(s => s.name === name && s.status === status).reduce((n, s) => n + s.count, 0))}</td>)}</tr>)}</Table>
    </section><section className="panel account-overview"><h2>用户与资源</h2>
      <div className="mini-stat"><span>注册用户</span><strong>{number(data.users.total)}</strong></div>
      <div className="mini-stat"><span>有效 PLUS</span><Jump view="users" params={{plan: 'plus'}}>{number(data.users.plus)}</Jump></div>
      <div className="mini-stat"><span>24 小时内提交用户</span><b>{number(data.users.submitted_24h)}</b></div>
      <div className="mini-stat"><span>24 小时内提交任务数</span><b>{number(data.submitted_24h)}</b></div>
      <div className="mini-stat"><span>在线且启用的节点 / 资源池</span><Jump view="nodes">{data.nodes.online_enabled} / {data.nodes.total}</Jump></div>
      <p className="panel-note">图像节点代表计算设备，控制资源池代表上传和文本的共享执行容量。</p>
    </section></div>
    <section className="panel completion-panel"><div className="panel-heading"><h2>近 24 小时交付表现</h2><span className="muted">总耗时包含等待与缓存命中任务。</span></div>
      {data.completed_24h.length ? <Table heads={['类型', '结果', '任务数', '平均总耗时']}>{data.completed_24h.map(s => <tr key={`${s.mode}-${s.workflow_kind}-${s.status}`}><td>{label(s.workflow_kind || 'image')}</td><td><Badge value={s.status}/></td><td>{number(s.count)}</td><td>{duration(s.avg_elapsed_seconds)}</td></tr>)}</Table> : <Empty>近 24 小时暂无结束的任务</Empty>}
    </section>
  </>;
}
