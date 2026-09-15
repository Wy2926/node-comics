import {useCallback, useEffect, useRef, useState} from 'react';
import {authError, type AuthConfig, errorText, finishLogin, getAdmin, hasSession, request, saveToken, startLogin} from './api';
import {TaskDetail, UserDetail} from './Details';
import {Nodes, Tasks, Users} from './Lists';
import {Overview} from './Overview';
import type {AdminUser, Nodes as NodesData, Overview as OverviewData, Page, Task, TaskDetail as TaskData, User, UserDetail as UserData} from './types';
import {Empty, href, label, Pagination, time} from './ui';

const views = {
  overview: ['运行概览', 'LIVE OPERATIONS', '从用户提交到译图交付，掌握当前运行情况。', '◫'],
  tasks: ['翻译任务', 'TRANSLATION TASKS', '逐页查看执行状态、等待时间与节点履历。', '≡'],
  nodes: ['计算节点', 'COMPUTE RESOURCES', '查看图像计算节点与控制资源池的心跳、容量和占用。', '▦'],
  users: ['用户管理', 'READER ACCOUNTS', '查看用户会员状态、翻译活动和当前页数额度。', '♙'],
} as const;
type View = keyof typeof views;
type Target = {kind: 'tasks' | 'users'; id: string};

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
    <label className="search-label">搜索<input name="q" maxLength={120} defaultValue={params.get('q') || ''} placeholder={view === 'tasks' ? '任务 ID / 用户名称' : '用户名称 / ID'}/></label>
    {view === 'tasks' ? <>{select('mode', '翻译模式', ['classic', 'redraw'])}
      {select('status', '任务状态', ['active', 'attention', 'queued', 'running', 'awaiting_upload', 'validating_upload', 'succeeded', 'no_text', 'failed', 'outcome_unknown', 'unknown_released', 'cancelled'])}
      {select('priority', '当前优先级', ['realtime', 'preload'])}</> :
      <label>会员类型<select name="plan" defaultValue={params.get('plan') || ''}><option value="">全部</option><option value="free">普通</option><option value="plus">PLUS</option></select></label>}
    <button className="primary">筛选</button><button type="button" className="secondary" onClick={() => onChange({})}>重置</button>
  </form>
    {['owner_id', 'node_id'].filter(k => params.has(k)).map(k => <span className="scope-chip" key={k}>{k === 'owner_id' ? '用户' : '节点'}：{params.get(k)}</span>)}
  </section>;
}

function DetailDialog({target, onClose, onUnauthorized}: {target: Target; onClose: () => void; onUnauthorized: (message: string) => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const {data, busy, error, reload} = useResource<TaskData | UserData>(`/v1/admin/monitor/${target.kind}/${encodeURIComponent(target.id)}`, onUnauthorized);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current!; element.showModal();
    return () => {element.close(); if (opener?.isConnected) opener.focus();};
  }, []);
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="detail-title">
    <div className="dialog-top"><h2 id="detail-title">{target.kind === 'tasks' ? '翻译任务详情' : '用户权益'}</h2>
      <div><button className="secondary" disabled={busy} onClick={reload}>{busy ? '正在刷新…' : '刷新详情'}</button><button className="secondary" onClick={onClose} aria-label="关闭详情">关闭 ×</button></div></div>
    <div className="dialog-content" aria-busy={busy}>
      {error && <p className="error" role="alert">{error} 请点击“刷新详情”重试。{data && ' 当前详情可能已过时。'}</p>}
      {!data && busy && <p className="loading" role="status">正在读取详情…</p>}
      {data && (target.kind === 'tasks' ? <TaskDetail job={data as TaskData}/> : <UserDetail user={data as UserData}/>)}
    </div>
  </dialog>;
}

function WorkspacePage({view, params, onUnauthorized, onNavigate, auto, setAuto}: {view: View; params: URLSearchParams; onUnauthorized: (message: string) => void; onNavigate: (values: Record<string, string>) => void; auto: boolean; setAuto: (value: boolean) => void}) {
  const [detail, setDetail] = useState<Target>();
  const query = new URLSearchParams();
  const allowed = view === 'tasks' ? ['mode', 'status', 'priority', 'q', 'owner_id', 'node_id', 'offset'] : view === 'users' ? ['q', 'plan', 'offset'] : [];
  for (const key of allowed) if (params.get(key)) query.set(key, params.get(key)!);
  const {data, busy, error, reload} = useResource<OverviewData | NodesData | Page<Task> | Page<AdminUser>>(`/v1/admin/monitor/${view}?${query}`, onUnauthorized, auto && !detail);
  const page = data as Page<Task> | Page<AdminUser> | undefined;
  const [title, eyebrow, description] = views[view];
  useEffect(() => {document.title = `${title} · Node Comics 管理后台`;}, [title]);
  return <main id="main" tabIndex={-1}>
    <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></div>
      <div className="refresh-controls"><label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/>每 15 秒刷新</label><button className="secondary" disabled={busy} onClick={reload}>{busy ? '正在刷新…' : '↻ 刷新数据'}</button></div></div>
    <div className="sync-line"><span role="status">{busy ? '正在读取数据…' : error ? '更新失败 · 当前数据可能已过时' : `已更新 ${time(data?.generated_at)}`}{!auto && ' · 自动刷新已暂停'}</span><span>时间按浏览器本地时区显示</span></div>
    {error && <div className="error" role="alert">{error}</div>}
    <Filters view={view} params={params} onChange={values => {if (href(view, values) === location.hash) reload(); else onNavigate(values);}}/>
    <div aria-busy={busy}>
      {!data && (busy ? <div className="loading" role="status">正在读取数据…</div> : <Empty>暂时无法读取数据，请点击刷新重试</Empty>)}
      {data && view === 'overview' && <Overview data={data as OverviewData}/>}
      {data && view === 'nodes' && <Nodes data={data as NodesData}/>}
      {data && (view === 'tasks' || view === 'users') && <><section className="panel list-panel">
        {view === 'tasks' ? <Tasks items={(data as Page<Task>).items} onTask={id => setDetail({kind: 'tasks', id})}/> : <Users items={(data as Page<AdminUser>).items} onUser={id => setDetail({kind: 'users', id})}/>}
        <Pagination total={page!.total} count={page!.items.length} offset={Number(params.get('offset') || 0)} next={page!.next_offset} onPage={offset => onNavigate({...Object.fromEntries(params), offset: String(offset)})}/>
      </section>{view === 'tasks' && <p className="footnote">执行占用按租约时间合并，并行阶段不重复累计；总耗时包含上传、等待与恢复。节点筛选包含该节点曾参与的全部任务。</p>}</>}
    </div>
    {detail && <DetailDialog key={detail.id} target={detail} onClose={() => setDetail(undefined)} onUnauthorized={onUnauthorized}/>}
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
  return <><a className="skip" href="#main" onClick={event => {event.preventDefault(); document.getElementById('main')?.focus();}}>跳转到主要内容</a>{!user ? <section className="login-screen"><div className="login-card">
    <span className="brand-mark" aria-hidden="true">N<span>✦</span></span><p className="eyebrow">NODE COMICS / OPERATIONS</p><h1>每一页，都有迹可循。</h1><p className="muted">登录管理后台，查看用户、翻译队列与节点运行情况。</p>
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
      <button className="primary" disabled={authBusy || !config}>{authBusy ? '正在连接…' : config?.dev_auth ? '登录开发环境' : '使用统一身份登录'}</button>
    </form>
    {authMessage && <p className="error" role="alert">{authMessage}</p>}{!config && !authBusy && <button className="secondary" onClick={() => setBoot(n => n + 1)}>重新连接</button>}
    <p className="footnote">仅管理员可访问业务数据</p>
  </div></section> : <div className="workspace"><aside className="sidebar"><a href="#overview" className="brand"><span className="brand-mark" aria-hidden="true">N<span>✦</span></span><span>Node Comics<small>管理后台</small></span></a>
    <p className="nav-label">工作空间</p><nav aria-label="后台导航">{Object.entries(views).map(([key, values]) => <a href={href(key)} key={key} aria-current={view === key ? 'page' : undefined}><span aria-hidden="true">{values[3]}</span>{values[0]}</a>)}</nav>
    <div className="sidebar-bottom"><span className="tiny-label">ADMINISTRATOR</span><b>{user.name}</b><button onClick={() => logout()}>退出登录 ↗</button></div>
  </aside><div className="main-wrap"><header className="topbar"><span>控制中心 <span className="muted">/</span> <b>{views[view][0]}</b></span><span className="top-brand">NODE COMICS <span className="dot"/></span></header>
    <WorkspacePage key={hash} view={view} params={params} auto={auto} setAuto={setAuto} onUnauthorized={logout} onNavigate={values => {location.hash = href(view, values);}}/>
    <footer>Node Comics · Operations <span>用户与任务数据仅供管理使用</span></footer>
  </div></div>}</>;
}
