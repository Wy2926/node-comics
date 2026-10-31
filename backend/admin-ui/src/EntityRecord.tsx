import {Button} from './ui';
import {useContext, useState} from 'react';
import {Tabs} from 'antd';
import {EntityContext, type Entity} from './EntityLink';
import {TaskDetail, UserDetail} from './Details';
import {Tasks} from './Lists';
import {useBillingResource} from './BillingShared';
import {BillingOrdersPage} from './BillingOrders';
import {BillingSubscriptionsPage} from './BillingSubscriptions';
import {FeedbackPage} from './FeedbackPage';
import {UserDiagnosticsPanel} from './UserDiagnostics';
import {Pagination} from './ui';
import type {Page, Task, TaskDetail as TaskData, UserDetail as UserData} from './types';

type Auth = {onUnauthorized: (message: string) => void};
function UserTasks({id, onUnauthorized}: Auth & {id: string}) {
  const [offset, setOffset] = useState(0), open = useContext(EntityContext);
  const {data, loading, error, reload} = useBillingResource<Page<Task>>(`/v1/admin/monitor/tasks?owner_id=${encodeURIComponent(id)}&offset=${offset}`, onUnauthorized);
  return <><div className="surface-toolbar"><p>该用户的所有翻译任务</p><Button className="secondary" disabled={loading} onClick={() => void reload()}>刷新任务</Button></div>
    {error && <p className="error" role="alert">{error}</p>}{!data ? <p role="status">{loading ? '正在读取任务…' : '暂时无法读取任务'}</p> : <>
      <Tasks items={data.items} onTask={id => open({kind: 'tasks', id})}/><Pagination total={data.total} count={data.items.length} next={data.next_offset} offset={offset} onPage={setOffset}/></>}
  </>;
}
function UserRecord({id, onUnauthorized}: Auth & {id: string}) {
  const {data, loading, error, reload} = useBillingResource<UserData>(`/v1/admin/monitor/users/${encodeURIComponent(id)}`, onUnauthorized);
  const [tab, setTab] = useState('profile');
  const [queries, setQueries] = useState<Record<string, Record<string, string>>>({});
  const params = (key: string) => new URLSearchParams({...queries[key], owner_id: id});
  const navigate = (key: string) => (values: Record<string, string>) => setQueries(current => ({...current, [key]: values}));
  return <div className="user-record">
    <div className="record-heading"><div className="user-avatar">{data?.name.slice(0, 1) || 'U'}</div><div><h2>{data?.name || '用户详情'}</h2><p className="muted">在同一处查看权益、交易和使用记录</p></div><Button className="secondary" disabled={loading} onClick={() => void reload()}>刷新用户</Button></div>
    {error && <p className="error" role="alert">{error}</p>}
    <Tabs activeKey={tab} onChange={setTab} items={[
      {key: 'profile', label: '概要与权益', children: data ? <UserDetail user={data} onChanged={() => void reload()} onUnauthorized={onUnauthorized}/> : <p role="status">{loading ? '正在读取用户…' : '用户数据暂不可用'}</p>},
      {key: 'tasks', label: '翻译任务', children: <UserTasks id={id} onUnauthorized={onUnauthorized}/>},
      {key: 'orders', label: '订单', children: <BillingOrdersPage embedded params={params('orders')} onNavigate={navigate('orders')} onUnauthorized={onUnauthorized}/>},
      {key: 'subscriptions', label: '订阅', children: <BillingSubscriptionsPage embedded params={params('subscriptions')} onNavigate={navigate('subscriptions')} onUnauthorized={onUnauthorized}/>},
      {key: 'feedback', label: '反馈', children: <FeedbackPage embedded params={params('feedback')} onNavigate={navigate('feedback')} onUnauthorized={onUnauthorized}/>},
      {key: 'diagnostics', label: '请求诊断', children: <UserDiagnosticsPanel owner={id} onUnauthorized={onUnauthorized}/>},
    ]}/>
  </div>;
}
function TaskRecord({id, onUnauthorized}: Auth & {id: string}) {
  const {data, loading, error, reload} = useBillingResource<TaskData>(`/v1/admin/monitor/tasks/${encodeURIComponent(id)}`, onUnauthorized);
  return <><div className="surface-toolbar"><p>任务详情</p><Button className="secondary" disabled={loading} onClick={() => void reload()}>刷新详情</Button></div>
    {error && <p className="error" role="alert">{error}</p>}{data ? <TaskDetail job={data} onUnauthorized={onUnauthorized}/> : <p role="status">{loading ? '正在读取详情…' : '详情暂不可用'}</p>}</>;
}
export default function EntityRecord({entity, onUnauthorized}: Auth & {entity: Entity}) {
  return entity.kind === 'users' ? <UserRecord id={entity.id} onUnauthorized={onUnauthorized}/> : <TaskRecord id={entity.id} onUnauthorized={onUnauthorized}/>;
}
