import {Button} from './ui';
import {useAdminResource, DataTable, ResourceError, type Row} from './AdminResource';
import {Stat, time} from './ui';
const c = (key: string, title: string, format?: 'time') => ({key, title, format});
type Health = {items: Row[]; alerts: Record<string, number>; billing_backlog: Row[]; generated_at: string};


function HealthPanel({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  const {data, error, busy, reload} = useAdminResource<Health>('/v1/admin/operations/health', onUnauthorized);
  const alertLabels: Record<string, string> = {outcome_unknown: '结果未知任务', unknown_released: '未知结果已释放', overdue_ready_stages: '等待过久阶段', expired_leases: '过期执行租约'};
  return <><div className="surface-toolbar"><p>查看当前实例、积压与异常，按下方记录定位原因。</p><Button className="secondary" disabled={busy} onClick={reload}>刷新服务状态</Button></div><ResourceError error={error} stale={!!data}/>{busy && <p role="status">正在读取服务状态…</p>}
    {data && <><div className="stats-grid">{Object.entries(alertLabels).map(([key, title]) => <Stat key={key} title={title} value={String(data.alerts[key] || 0)} note={`最多计数 ${data.alerts.count_limit} 条`}/>)}</div>
      <section className="panel"><h2>服务实例</h2><DataTable rows={data.items.map(row => ({...row, status: ({healthy: '正常', unhealthy: '异常或离线', missing: '尚无心跳'} as Record<string,string>)[String(row.status)]}))}
        columns={[c('role', '服务'), c('instance_id', '实例'), c('status', '状态'), c('last_success_at', '最后成功', 'time'), c('consecutive_failures', '连续失败'), c('failure_count', '累计失败'), c('last_error_code', '最近错误')]}/></section>
      <section className="panel"><h2>支付通知积压</h2><DataTable rows={data.billing_backlog} columns={[c('provider', '渠道'), c('environment', '环境'), c('status', '状态'), c('count', '数量'), c('oldest_received_at', '最早接收', 'time'), c('max_attempts', '最多处理次数')]}/></section>
      <p className="footnote">快照时间 {time(data.generated_at)}。心跳反映当前进程健康；支付积压请到支付事件页核查。</p></>}
  </>;
}


export function ServiceHealthPage({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  return <main id="main" tabIndex={-1}><div className="page-heading"><div><h1>服务健康</h1><p className="muted">查看服务实例和需要处理的运行异常。</p></div></div><HealthPanel onUnauthorized={onUnauthorized}/></main>;
}
