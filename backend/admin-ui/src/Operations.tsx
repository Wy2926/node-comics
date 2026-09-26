import {useState} from 'react';
import {DataTable, ResourceError, useAdminResource, type Column, type DataPage, type Row} from './AdminResource';
import {Pagination, Stat, time} from './ui';

const c = (key: string, title: string, format?: Column['format']): Column => ({key, title, format});
const common = [c('id', '编号'), c('owner_id', '用户')];
const catalog = {
  uploads: {title: '上传会话', filters: ['owner_id', 'job_id', 'status'], columns: [...common, c('job_id', '任务'), c('status', '状态'),
    c('expected_size', '期望字节数'), c('expires_at', '到期', 'time'), c('ingress_expires_at', '上传占位到期', 'time'), c('error_code', '错误码'), c('error_message', '原因')]},
  requests: {title: '翻译请求', filters: ['owner_id', 'job_id', 'request_id', 'access_id'], columns: [c('owner_id', '用户'), c('id', '请求编号'),
    c('job_id', '真实任务'), c('access_id', '复用授权'), c('created_at', '受理时间', 'time')]},
  assets: {title: '图片记录', filters: ['owner_id', 'q', 'job_id'], columns: [...common, c('sha256', '图片哈希'), c('kind', '类型'),
    c('available', '访问记录有效'), c('byte_size', '字节数'), c('active_references', '活跃引用'), c('result_access_count', '结果授权引用'),
    c('file_page_count', '文件页映射'), c('last_accessed_at', '最近授权访问', 'time'), c('deleted_at', '撤销时间', 'time')]},
  'file-pages': {title: '文件页映射', filters: ['owner_id', 'file_hash', 'asset_id'], columns: [c('owner_id', '用户'), c('file_hash', '文件哈希'), c('page_index', '原始页索引'), c('asset_id', '图片编号')]},
  results: {title: '生成版本', filters: ['owner_id', 'q', 'mode'], columns: [...common, c('mode', '模式'), c('target_language', '目标语言'), c('version', '版本'),
    c('status', '生成状态'), c('access_count', '复用授权数'), c('input_asset_id', '原图'), c('output_asset_id', '译图'), c('generated_at', '生成时间', 'time')]},
  accesses: {title: '结果授权', filters: ['owner_id', 'result_id'], columns: [...common, c('result_id', '生成任务'), c('version', '版本'), c('available', '有效'),
    c('input_asset_id', '原图访问记录'), c('output_asset_id', '译图访问记录'), c('created_at', '授权时间', 'time')]},
} as const;
const fieldLabels: Record<string, string> = {owner_id: '用户 ID', job_id: '任务 ID', status: '状态', request_id: '请求编号', access_id: '复用授权 ID', q: '图片哈希 / 编号', mode: '翻译模式', file_hash: '文件哈希', asset_id: '图片 ID', result_id: '生成任务 ID'};
type View = 'health' | 'user' | 'provider-history' | keyof typeof catalog;
type Health = {items: Row[]; alerts: Record<string, number>; billing_backlog: Row[]; generated_at: string};
type UserDiagnostics = {owner_id: string; owner_name: string; image_budget: {limit: number; remaining: number; retry_after_seconds: number};
  upload_active: number; controls: Row[]; comic_title_budget: Row; feedback: Row | null; generated_at: string};

function HealthPanel({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  const {data, error, busy, reload} = useAdminResource<Health>('/v1/admin/operations/health', onUnauthorized);
  const alertLabels: Record<string, string> = {outcome_unknown: '结果未知任务', unknown_released: '未知结果已释放', overdue_ready_stages: '等待过久阶段', expired_leases: '过期执行租约'};
  return <><div className="surface-toolbar"><p>查看当前实例、积压与异常，按下方记录定位原因。</p><button className="secondary" disabled={busy} onClick={reload}>刷新服务状态</button></div><ResourceError error={error} stale={!!data}/>{busy && <p role="status">正在读取服务状态…</p>}
    {data && <><div className="stats-grid">{Object.entries(alertLabels).map(([key, title]) => <Stat key={key} title={title} value={String(data.alerts[key] || 0)} note={`最多计数 ${data.alerts.count_limit} 条`}/>)}</div>
      <section className="panel"><h2>服务实例</h2><DataTable rows={data.items.map(row => ({...row, status: ({healthy: '正常', unhealthy: '异常或离线', missing: '尚无心跳'} as Record<string,string>)[String(row.status)]}))}
        columns={[c('role', '服务'), c('instance_id', '实例'), c('status', '状态'), c('last_success_at', '最后成功', 'time'), c('consecutive_failures', '连续失败'), c('failure_count', '累计失败'), c('last_error_code', '最近错误')]}/></section>
      <section className="panel"><h2>支付通知积压</h2><DataTable rows={data.billing_backlog} columns={[c('provider', '渠道'), c('environment', '环境'), c('status', '状态'), c('count', '数量'), c('oldest_received_at', '最早接收', 'time'), c('max_attempts', '最多处理次数')]}/></section>
      <p className="footnote">快照时间 {time(data.generated_at)}。心跳反映当前进程健康；支付积压请到支付事件页核查。</p></>}
  </>;
}

function UserPanel({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  const [owner, setOwner] = useState('');
  const {data, error, busy, reload} = useAdminResource<UserDiagnostics>(owner ? `/v1/admin/operations/users/${encodeURIComponent(owner)}` : undefined, onUnauthorized);
  return <><form className="filters filter-form" onSubmit={event => {event.preventDefault(); const next = String(new FormData(event.currentTarget).get('owner') || '').trim(); if (next === owner) reload(); else setOwner(next);}}>
    <label>用户 ID<input name="owner" required maxLength={36}/></label><button className="primary" disabled={busy}>查询用户</button></form><ResourceError error={error} stale={!!data}/>
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

function ProviderHistory({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  const {data: providers} = useAdminResource<{items: {id: string; name: string}[]}>('/v1/admin/translation-providers', onUnauthorized);
  const [provider, setProvider] = useState(''), [offset, setOffset] = useState(0);
  const {data, error, busy, reload} = useAdminResource<DataPage>(provider ? `/v1/admin/translation-providers/${encodeURIComponent(provider)}/revisions?offset=${offset}` : undefined, onUnauthorized);
  return <><div className="filters filter-form"><label>文本供应商<select value={provider} onChange={event => {setProvider(event.target.value); setOffset(0);}}><option value="">请选择</option>
    {providers?.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="secondary" disabled={!provider || busy} onClick={reload}>刷新版本</button></div>
    <ResourceError error={error} stale={!!data}/>{data && <section className="panel">{data.items.map(row => <details key={String(row.id)}><summary>{time(String(row.created_at))} · {String(row.id)}{row.current ? ' · 当前版本' : ''}</summary>
      <pre className="admin-json">{JSON.stringify(row.config, null, 2)}</pre></details>)}
      <Pagination total={data.total} count={data.items.length} offset={offset} next={data.next_offset} onPage={setOffset}/></section>}
    <p className="footnote">版本保持不可变，不显示历史密钥。操作人和修改前后值见操作审计。</p></>;
}

function ListPanel({view, onUnauthorized}: {view: keyof typeof catalog; onUnauthorized: (message: string) => void}) {
  const definition = catalog[view], [query, setQuery] = useState(new URLSearchParams());
  const {data, error, busy, reload} = useAdminResource<DataPage>(`/v1/admin/operations/${view}?${query}`, onUnauthorized);
  return <><form className="filters filter-form" onSubmit={event => {event.preventDefault(); const next = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) if (String(value).trim()) next.set(key, String(value).trim()); if (next.toString() === query.toString()) reload(); else setQuery(next);}}>
    {definition.filters.map(key => <label key={key}>{fieldLabels[key]}<input name={key} maxLength={key === 'request_id' ? 36 : 64}/></label>)}
    <div className="filter-actions"><button type="reset" className="secondary" onClick={() => setQuery(new URLSearchParams())}>重置</button><button type="button" className="secondary" onClick={reload} disabled={busy}>刷新</button><button className="primary">查询</button></div></form>
    <ResourceError error={error} stale={!!data}/>{busy && <p role="status">正在读取{definition.title}…</p>}
    {data && <section className="panel"><DataTable rows={data.items} columns={[...definition.columns]}/>
      <Pagination total={data.total} count={data.items.length} offset={Number(query.get('offset') || 0)} next={data.next_offset}
        onPage={offset => setQuery(new URLSearchParams({...Object.fromEntries(query), offset: String(offset)}))}/></section>}
    <p className="footnote">仅查询记录与引用，不读取图片字节或探测对象存储。有效状态表示数据库中的访问记录有效。</p>
  </>;
}

export function OperationsPage({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  const [view, setView] = useState<View>('health');
  return <main id="main" tabIndex={-1} className="admin-surface"><div className="page-heading"><div><p className="eyebrow">SERVICE DIAGNOSTICS</p><h1>运行诊断</h1><p className="muted">追踪服务健康、上传、受理回执与图片授权关系。</p></div></div>
    <nav className="admin-tabs" aria-label="诊断类型">{Object.entries({health: '服务健康', user: '用户准入', ...Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, value.title])), 'provider-history': '供应商版本'})
      .map(([key, title]) => <button key={key} className={key === view ? 'primary' : 'secondary'} aria-pressed={key === view} onClick={() => setView(key as View)}>{title}</button>)}</nav>
    {view === 'health' ? <HealthPanel onUnauthorized={onUnauthorized}/> : view === 'user' ? <UserPanel onUnauthorized={onUnauthorized}/> : view === 'provider-history' ? <ProviderHistory onUnauthorized={onUnauthorized}/> : <ListPanel key={view} view={view} onUnauthorized={onUnauthorized}/>}
  </main>;
}
