import {Button} from './ui';
import {useAdminResource, DataTable, ResourceError, type Row} from './AdminResource';
import {Stat} from './ui';
const c = (key: string, title: string, format?: 'time') => ({key, title, format});
type UserDiagnostics = {owner_id: string; owner_name: string; image_budget: {limit: number; remaining: number; retry_after_seconds: number};
  upload_active: number; controls: Row[]; comic_title_budget: Row; feedback: Row | null; generated_at: string};

export function UserDiagnosticsPanel({owner, onUnauthorized}: {owner: string; onUnauthorized: (message: string) => void}) {
  const {data, error, busy, reload} = useAdminResource<UserDiagnostics>(owner ? `/v1/admin/operations/users/${encodeURIComponent(owner)}` : undefined, onUnauthorized);
  return <><div className="surface-toolbar"><p>当前用户的请求准入状态</p><Button className="secondary" onClick={reload} disabled={busy}>刷新诊断</Button></div><ResourceError error={error} stale={!!data}/>
    {data && <><h2>{data.owner_name}</h2><div className="stats-grid"><Stat title="本分钟剩余图片名额" value={`${data.image_budget.remaining} / ${data.image_budget.limit}`} note="跨模式、语言和设备合计"/>
      <Stat title="可再次受理等待" value={`${data.image_budget.retry_after_seconds} 秒`} note="当前滚动 60 秒窗口"/><Stat title="进行中上传" value={String(data.upload_active)} note="尚未到期的收流占位"/></div>
      <section className="panel"><h3>请求保护</h3><DataTable rows={data.controls} columns={[c('scope', '请求范围'), c('recorded_tokens', '记录的令牌余额'), c('active_leases', '活跃请求'), c('refilled_at', '最后更新', 'time')]}/>
        <p className="panel-note">令牌数为最近持久化快照，实时补充在下次请求时结算。</p></section>
      <section className="panel"><h3>漫画名查询限速</h3><DataTable rows={[data.comic_title_budget]} columns={[
        c('used', '近 60 秒已受理'), c('limit', '窗口上限'), c('remaining', '剩余次数'),
        c('retry_after_seconds', '再次受理等待（秒）'), c('last_request_at', '最近受理', 'time')]}/>
        <p className="panel-note">统计已受理的查询，包含缓存命中和失败；完成后仍计入窗口，与正在执行的请求数无关。</p></section>
      {data.feedback && <section className="panel"><h3>反馈预算</h3><DataTable rows={[data.feedback]} columns={[c('daily_receipts', '记录窗口已收反馈'), c('day_started_at', '日窗口起点', 'time'), c('recorded_tokens', '记录的令牌余额'), c('refilled_at', '最后更新', 'time')]}/><p className="panel-note">显示最近持久化快照；跨 UTC 日后的窗口重置在下次反馈请求时结算。</p></section>}
    </>}
  </>;
}
