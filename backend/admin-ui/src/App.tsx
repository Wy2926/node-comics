import {Button} from './ui';
import {lazy, Suspense, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {authError, type AuthConfig, errorText, finishLogin, getAdmin, hasSession, request, saveToken, startLogin} from './api';
import {EntityWorkspace} from './EntityWorkspace';
import {EntityActiveContext, EntityContext} from './EntityLink';
import {InboxBell, InboxCount, InboxProvider} from './Inbox';
import {Tabs} from 'antd';
import {AppstoreOutlined, UserOutlined, ShoppingOutlined, InboxOutlined, FileImageOutlined, ApiOutlined, CloudServerOutlined, SettingOutlined} from '@ant-design/icons';
import {Nodes, Tasks, Users} from './Lists';
import {Overview} from './Overview';
import {NodeConfigDialog} from './NodeConfig';
const SystemSettingsPage = lazy(() => import('./SystemSettings').then(module => ({default: module.SystemSettingsPage})));
const TranslationProvidersPage = lazy(() => import('./TranslationProviders').then(module => ({default: module.TranslationProvidersPage})));
const BillingCatalogPage = lazy(() => import('./BillingCatalog').then(module => ({default: module.BillingCatalogPage})));
const BillingOrdersPage = lazy(() => import('./BillingOrders').then(module => ({default: module.BillingOrdersPage})));
const FeedbackPage = lazy(() => import('./FeedbackPage').then(module => ({default: module.FeedbackPage})));
const SupportRequestsPage = lazy(() => import('./SupportRequestsPage').then(module => ({default: module.SupportRequestsPage})));
const BillingEventsPage = lazy(() => import('./BillingEvents').then(module => ({default: module.BillingEventsPage})));
const BillingSubscriptionsPage = lazy(() => import('./BillingSubscriptions').then(module => ({default: module.BillingSubscriptionsPage})));
const AuditLogPage = lazy(() => import('./AuditLog').then(module => ({default: module.AuditLogPage})));
const ServiceHealthPage = lazy(() => import('./ServiceHealth').then(module => ({default: module.ServiceHealthPage})));
const StatisticsPage = lazy(() => import('./Statistics').then(module => ({default: module.StatisticsPage})));
const QuotaCampaignsPage = lazy(() => import('./QuotaCampaigns').then(module => ({default: module.QuotaCampaignsPage})));
import type {Node} from './types';
import type {AdminUser, Nodes as NodesData, Overview as OverviewData, Page, Task, User} from './types';
import {Empty, href, label, Pagination, time} from './ui';

const views = {
  overview: ['概览', '先处理反馈与订单，再查看用户和翻译运行情况。'],
  tasks: ['翻译任务', '查看单图与整本文件的状态、等待时间及节点履历。'],
  nodes: ['计算节点', '查看图像计算节点与控制资源池的心跳、容量和占用。'],
  'translation-providers': ['翻译供应商', '管理文本翻译的渠道、模型与独立供应商配置。'],
  users: ['用户管理', '查看用户会员状态、翻译活动和当前页数额度。'],
  'quota-campaigns': ['额度活动', '配置自动赠送规则与发放范围。'],
  billing: ['产品与价格', '管理套餐产品、月付／年付价格与支付渠道。'],
  orders: ['订单管理', '查看支付订单、订阅状态和流转记录。'],
  subscriptions: ['订阅与权益', '追溯客户、订阅、账单与授权周期。'],
  'billing-events': ['支付事件', '排查支付通知、处理失败与积压。'],
  feedback: ['翻译反馈', '处理读者反馈并记录处理过程。'],
  'plugin-feedback': ['插件反馈', '查看匿名提交的插件问题与建议。'],
  'uninstall-feedback': ['卸载反馈', '查看用户自愿提交的卸载原因与建议。'],
  'site-requests': ['网站适配申请', '查看匿名提交的网站兼容申请。'],
  health: ['服务健康', '查看服务实例和运行异常。'],
  statistics: ['用量与成本', '查看调用计量与业务统计。'],
  audit: ['操作审计', '查询管理员操作和变更记录。'],
  settings: ['系统设置', '管理翻译提示词、默认额度与请求保护设置。'],
} as const;
type View = keyof typeof views;
const navigationGroups: {name: string; pages: View[]}[] = [
  {name: '工作台', pages: ['overview', 'users', 'orders', 'feedback', 'tasks']},
  {name: '服务与配置', pages: ['translation-providers', 'nodes', 'settings']},
];
const sections: Partial<Record<View, View[]>> = {
  orders: ['orders', 'subscriptions', 'billing', 'billing-events'],
  feedback: ['feedback', 'plugin-feedback', 'uninstall-feedback', 'site-requests'],
  settings: ['settings', 'quota-campaigns', 'health', 'statistics', 'audit'],
};
const navIcons = {overview: AppstoreOutlined, users: UserOutlined, orders: ShoppingOutlined, feedback: InboxOutlined,
  tasks: FileImageOutlined, 'translation-providers': ApiOutlined, nodes: CloudServerOutlined, settings: SettingOutlined};
const sectionFor = (view: View) => (Object.entries(sections).find(([, children]) => children?.includes(view))?.[0] || view) as View;

function useResource<T>(url: string, onUnauthorized: (message: string) => void, auto = false) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const reload = useCallback(() => {if (!pending.current) setRevision(n => n + 1);}, []);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    pending.current = true; setBusy(true); setError('');
    request<T>(url, {signal: controller.signal}).then(result => {if (current) setData(result);})
      .catch(err => {if (!current || err.name === 'AbortError') return; if (authError(err)) onUnauthorized(errorText(err)); else setError(errorText(err));})
      .finally(() => {if (current) {setBusy(false); pending.current = false;}});
    return () => {current = false; controller.abort(); pending.current = false;};
  }, [url, revision, onUnauthorized]);
  useEffect(() => {
    if (!auto) return;
    const refresh = () => {if (!document.hidden) reload();};
    const timer = setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => {clearInterval(timer); document.removeEventListener('visibilitychange', refresh);};
  }, [auto, reload]);
  return {data, error, busy, reload};
}

function Filters({view, params, onChange}: {view: View; params: URLSearchParams; onChange: (values: Record<string, string>) => void}) {
  if (!['tasks', 'users'].includes(view)) return null;
  const select = (name: string, title: string, options: string[]) => <label>{title}<select name={name} defaultValue={params.get(name) || ''}>
    <option value="">全部</option>{options.map(v => <option value={v} key={v}>{label(v)}</option>)}</select></label>;
  return <section aria-label="筛选条件" className="filters"><form className="filter-form" onSubmit={event => {
    event.preventDefault();
    const next: Record<string, string> = {};
    for (const [key, value] of new FormData(event.currentTarget)) if (String(value).trim()) next[key] = String(value).trim();
    for (const key of ['owner_id', 'node_id']) if (params.get(key)) next[key] = params.get(key)!;
    onChange(next);
  }}>
    <label className="search-label">搜索<input name="q" maxLength={120} defaultValue={params.get('q') || ''} placeholder={view === 'tasks' ? '用户名或任务编号' : '搜索用户名称'}/></label>
    {view === 'tasks' ? <>{select('mode', '翻译模式', ['classic'])}
      {select('workflow_kind', '任务类型', ['image', 'document'])}
      {select('status', '任务状态', ['active', 'attention', 'queued', 'running', 'awaiting_upload', 'validating_upload', 'uploading', 'preflight', 'awaiting_quota', 'succeeded', 'no_text', 'failed', 'outcome_unknown', 'unknown_released', 'cancelled'])}
      </> :
      <label>会员类型<select name="plan" defaultValue={params.get('plan') || ''}><option value="">全部</option><option value="free">普通</option><option value="lite">Lite</option><option value="plus">PLUS</option></select></label>}
    <Button className="primary">筛选</Button><Button type="button" className="secondary" onClick={() => onChange({})}>重置</Button>
  </form>
    {['owner_id', 'node_id'].filter(k => params.has(k)).map(k => <span className="scope-chip" key={k}>{k === 'owner_id' ? '已限定所选用户' : '已限定所选节点'}</span>)}
  </section>;
}

function WorkspacePage({view, params, onUnauthorized, onNavigate, auto, setAuto}: {view: 'overview' | 'tasks' | 'users' | 'nodes'; params: URLSearchParams; onUnauthorized: (message: string) => void; onNavigate: (values: Record<string, string>) => void; auto: boolean; setAuto: (value: boolean) => void}) {
  const openEntity = useContext(EntityContext), detailOpen = useContext(EntityActiveContext);
  const [nodeConfig, setNodeConfig] = useState<Node | 'new'>();
  const query = new URLSearchParams();
  const allowed = view === 'tasks' ? ['mode', 'workflow_kind', 'status', 'q', 'owner_id', 'node_id', 'offset'] : view === 'users' ? ['q', 'plan', 'offset'] : [];
  for (const key of allowed) if (params.get(key)) query.set(key, params.get(key)!);
  const {data, busy, error, reload} = useResource<OverviewData | NodesData | Page<Task> | Page<AdminUser>>(`/v1/admin/monitor/${view}?${query}`, onUnauthorized, auto && !detailOpen);
  const page = data as Page<Task> | Page<AdminUser> | undefined;
  const [title, description] = views[view];
  useEffect(() => {document.title = `${title} · Node Comics 管理后台`;}, [title]);
  return <main id="main" tabIndex={-1}>
    <div className="page-heading"><div><h1>{title}</h1><p className="muted">{description}</p></div>
      <div className="refresh-controls"><label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/>每 15 秒刷新</label><Button className="secondary" disabled={busy} onClick={reload}>{busy ? '正在刷新…' : '↻ 刷新数据'}</Button></div></div>
    <div className="sync-line"><span role="status">{busy ? '正在读取数据…' : error ? '更新失败 · 当前数据可能已过时' : `已更新 ${time(data?.generated_at)}`}{!auto && ' · 自动刷新已暂停'}</span><span>时间按浏览器本地时区显示</span></div>
    {error && <div className="error" role="alert">{error}</div>}
    <Filters view={view} params={params} onChange={values => {if (href(view, values) === location.hash) reload(); else onNavigate(values);}}/>
    <div aria-busy={busy}>
      {!data && (busy ? <div className="loading" role="status">正在读取数据…</div> : <Empty>暂时无法读取数据，请点击刷新重试</Empty>)}
      {data && view === 'overview' && <Overview data={data as OverviewData}/>}
      {view === 'nodes' && <div className="node-actions"><Button className="primary" onClick={() => setNodeConfig('new')}>＋ 添加翻译节点</Button></div>}
      {data && view === 'nodes' && <Nodes data={data as NodesData} onConfigure={setNodeConfig}/>}
      {data && (view === 'tasks' || view === 'users') && <><section className="panel list-panel">
        {view === 'tasks' ? <Tasks items={(data as Page<Task>).items} onTask={id => openEntity({kind: 'tasks', id})}/> : <Users items={(data as Page<AdminUser>).items} onUser={id => openEntity({kind: 'users', id})}/>}
        <Pagination total={page!.total} count={page!.items.length} offset={Number(params.get('offset') || 0)} next={page!.next_offset} onPage={offset => onNavigate({...Object.fromEntries(params), offset: String(offset)})}/>
      </section>{view === 'tasks' && <p className="footnote">执行占用按租约时间合并，并行阶段不重复累计；总耗时包含上传、等待与恢复。节点筛选包含该节点曾参与的全部任务。</p>}</>}
    </div>
    {nodeConfig && <NodeConfigDialog node={nodeConfig} onClose={() => setNodeConfig(undefined)} onSaved={reload}/>}
  </main>;
}

export function App() {
  const [user, setUser] = useState<User>();
  const [config, setConfig] = useState<AuthConfig>();
  const [authBusy, setAuthBusy] = useState(true);
  const [authMessage, setAuthMessage] = useState('');
  const [hash, setHash] = useState(location.hash);
  const [boot, setBoot] = useState(0);
  const [auto, setAuto] = useState(true);
  const logout = useCallback((message = '') => {saveToken(''); setUser(undefined); setAuthMessage(message);}, []);
  useEffect(() => {
    const update = () => setHash(location.hash); window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    let active = true;
    setAuthBusy(true); setAuthMessage('');
    async function initialize() {
      try {
        const auth = await request<AuthConfig>('/v1/auth/config');
        if (!active) return;
        setConfig(auth); await finishLogin(auth);
        if (hasSession()) {const account = await getAdmin(); if (active) setUser(account);}
      } catch (error) {if (active) {if (authError(error)) saveToken(''); setAuthMessage(errorText(error));}}
      finally {if (active) setAuthBusy(false);}
    }
    void initialize(); return () => {active = false;};
  }, [boot]);
  const [rawView, query = ''] = hash.slice(1).split('?');
  const view = (Object.hasOwn(views, rawView) ? rawView : 'overview') as View;
  const params = new URLSearchParams(query);
  const section = sectionFor(view);
  return <><a className="skip" href="#main" onClick={event => {event.preventDefault(); document.getElementById('main')?.focus();}}>跳转到主要内容</a>{!user ? <section className="login-screen"><div className="login-card">
    <span className="brand-mark" aria-hidden="true">N</span><h1>管理工作台</h1><p className="muted">登录后管理用户、订单、反馈与翻译服务。</p>
    <form onSubmit={async event => {
      event.preventDefault(); if (!config) return;
      const username = String(new FormData(event.currentTarget).get('username') || '').trim();
      setAuthBusy(true); setAuthMessage('');
      try {
        if (config.dev_auth) {
          const login = await request<{access_token: string}>('/v1/auth/dev', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username})});
          saveToken(login.access_token); setUser(await getAdmin());
        } else await startLogin(config);
      } catch (error) {saveToken(''); setAuthMessage(errorText(error));}
      finally {setAuthBusy(false);}
    }}>
      {config?.dev_auth && <label>开发环境用户名<input name="username" autoComplete="username" maxLength={60} placeholder="管理员用户名" required/></label>}
      <Button className="primary" disabled={authBusy || !config}>{authBusy ? '正在连接…' : config?.dev_auth ? '登录开发环境' : '使用统一身份登录'}</Button>
    </form>
    {authMessage && <p className="error" role="alert">{authMessage}</p>}{!config && !authBusy && <Button className="secondary" onClick={() => setBoot(n => n + 1)}>重新连接</Button>}
    <p className="footnote">仅管理员可访问业务数据</p>
  </div></section> : <InboxProvider onUnauthorized={logout}><EntityWorkspace onUnauthorized={logout}><div className="workspace"><aside className="sidebar"><a href="#overview" className="brand"><span className="brand-mark" aria-hidden="true">N</span><span>Node Comics<small>管理后台</small></span></a>
    <nav aria-label="后台导航">{navigationGroups.map(group => <div className="nav-group" key={group.name}><p className="nav-group-label">{group.name}</p>{group.pages.map(key => <a href={href(key)} key={key} aria-current={section === key ? 'page' : undefined}><span aria-hidden="true">{(() => {const Icon = navIcons[key as keyof typeof navIcons]; return Icon ? <Icon/> : null;})()}</span>{key === 'feedback' ? '反馈收件箱' : views[key][0]}{key === 'feedback' && <InboxCount/>}</a>)}</div>)}</nav>
    <div className="sidebar-bottom"><b>{user.name}</b><Button onClick={() => logout()}>退出登录 ↗</Button></div>
  </aside><div className="main-wrap"><header className="topbar"><span>控制中心 <span className="muted">/</span> <b>{views[view][0]}</b></span><div className="topbar-actions"><span className="muted">{user.name}</span><InboxBell/></div></header>
    {sections[section] && <div className="section-tabs"><Tabs activeKey={view} onChange={key => {location.hash = href(key);}} items={sections[section]!.map(key => ({key, label: views[key][0]}))}/></div>}
    <Suspense fallback={<div className="loading" role="status">正在打开页面…</div>}>{view === 'settings' ? <SystemSettingsPage onUnauthorized={logout}/> :
      view === 'quota-campaigns' ? <QuotaCampaignsPage onUnauthorized={logout}/> :
      view === 'translation-providers' ? <TranslationProvidersPage onUnauthorized={logout}/> :
      view === 'feedback' ? <FeedbackPage key={hash} params={params} onUnauthorized={logout} onNavigate={values => {location.hash = href(view, values);}}/> :
      view === 'site-requests' || view === 'plugin-feedback' || view === 'uninstall-feedback' ? <SupportRequestsPage key={hash} params={params} kind={view === 'site-requests' ? 'website' : view === 'uninstall-feedback' ? 'uninstall' : 'plugin'} onUnauthorized={logout}/> :
      view === 'billing-events' ? <BillingEventsPage key={hash} params={params} onUnauthorized={logout} onNavigate={values => {location.hash = href(view, values);}}/> :
      view === 'subscriptions' ? <BillingSubscriptionsPage key={hash} params={params} onUnauthorized={logout} onNavigate={values => {location.hash = href(view, values);}}/> :
      view === 'audit' ? <AuditLogPage onUnauthorized={logout}/> :
      view === 'health' ? <ServiceHealthPage onUnauthorized={logout}/> :
      view === 'statistics' ? <StatisticsPage onUnauthorized={logout}/> :
      view === 'billing' ? <BillingCatalogPage onUnauthorized={logout}/> :
      view === 'orders' ? <BillingOrdersPage key={hash} params={params} onUnauthorized={logout} onNavigate={values => {location.hash = href(view, values);}}/> :
      <WorkspacePage key={hash} view={view} params={params} auto={auto} setAuto={setAuto} onUnauthorized={logout} onNavigate={values => {location.hash = href(view, values);}}/>}
    </Suspense><footer>Node Comics · Operations <span>用户与任务数据仅供管理使用</span></footer>
  </div></div></EntityWorkspace></InboxProvider>}</>;
}
