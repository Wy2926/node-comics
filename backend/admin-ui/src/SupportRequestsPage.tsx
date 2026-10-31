import {useEffect, useState} from 'react';
import {Alert, Button, Form, Input, Select, Tag} from 'antd';
import {authError, errorText, request} from './api';
import {BillingDialog, useBillingResource} from './BillingShared';
import {Empty, Pagination, Table, time} from './ui';

type SiteRequest = {id: string; kind: string; site_name: string; url: string; comment: string; contact: string; created_at: string;
  status: string; review_note: string; reviewed_at: string | null};
type Page = {items: SiteRequest[]; total: number; next_offset: number | null};
const statuses: Record<string, string> = {received: '待处理', reviewing: '处理中', resolved: '已解决'};
function Review({id, onClose, onChanged, onUnauthorized}: {id: string; onClose: () => void; onChanged: () => Promise<void>; onUnauthorized: (message: string) => void}) {
  const {data, loading, error, reload} = useBillingResource<SiteRequest>(`/v1/admin/support-requests/${encodeURIComponent(id)}`, onUnauthorized);
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState('');
  return <BillingDialog title="处理反馈" onClose={onClose} busy={busy}>
    {error && <Alert type="error" title={error} action={<Button onClick={() => void reload()}>重试</Button>}/>}
    {!data ? <p role="status">{loading ? '正在读取反馈…' : '反馈暂不可用'}</p> : <>
      <div className="support-message"><Tag>{statuses[data.status]}</Tag><h2>{data.site_name || '读者反馈'}</h2><p>{data.comment || '申请适配网站'}</p>
        {data.url && <a className="text-link" href={data.url} target="_blank" rel="noopener noreferrer">{data.url} ↗</a>}
        <p className="muted">{time(data.created_at)} · 联系方式：{data.contact || '未填写'}</p>
      </div>
      {data.review_note && <Alert type="info" title="最近处理备注" description={`${data.review_note} · ${time(data.reviewed_at)}`}/>}
      {actionError && <Alert type="error" title={actionError}/>}
      <Form layout="vertical" className="support-review-form" initialValues={{status: data.status === 'received' ? 'reviewing' : data.status, note: ''}}
        onFinish={async (values: {status: string; note: string}) => {
          if (busy) return; setBusy(true); setActionError('');
          try {await request(`/v1/admin/support-requests/${encodeURIComponent(id)}`, {method: 'PATCH', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({...values, expected_reviewed_at: data.reviewed_at})}); await onChanged(); onClose();}
          catch (failure) {if (authError(failure)) onUnauthorized(errorText(failure)); else {setActionError(errorText(failure)); await reload();}}
          finally {setBusy(false);}
        }}>
        <Form.Item name="status" label="处理状态" rules={[{required: true}]}><Select options={Object.entries(statuses).map(([value, label]) => ({value, label}))}/></Form.Item>
        <Form.Item name="note" label="处理备注" rules={[{required: true, whitespace: true, message: '请填写核实情况或处理结果'}]}><Input.TextArea rows={4} maxLength={500} showCount placeholder="记录核实情况、处理结果或下一步安排"/></Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} disabled={loading || !!error}>保存处理记录</Button>
      </Form>
    </>}
  </BillingDialog>;
}
export function SupportRequestsPage({kind, params, onUnauthorized}: {kind: 'website' | 'plugin' | 'uninstall'; params?: URLSearchParams; onUnauthorized: (message: string) => void}) {
  const title = kind === 'website' ? '网站适配申请' : kind === 'uninstall' ? '卸载反馈' : '插件反馈';
  const [offset, setOffset] = useState(0), [status, setStatus] = useState(''), [detail, setDetail] = useState<string | undefined>(() => params?.get('detail') || undefined);
  const {data, loading, error, reload} = useBillingResource<Page>(`/v1/admin/support-requests?kind=${kind}&offset=${offset}&limit=25${status ? `&status=${status}` : ''}`, onUnauthorized);
  useEffect(() => {document.title = `${title} · Node Comics 管理后台`;}, [title]);
  useEffect(() => {const changed = () => {void reload();}; window.addEventListener('admin-inbox-changed', changed); return () => window.removeEventListener('admin-inbox-changed', changed);}, [reload]);
  return <main id="main" tabIndex={-1}>
    <div className="page-heading"><div><h1>{title}</h1><p className="muted">读者的建议与问题，统一核实并记录处理结果。</p></div><Button disabled={loading} onClick={() => void reload()} loading={loading}>刷新反馈</Button></div>
    <section className="filters"><label>处理状态<Select aria-label="处理状态筛选" value={status} onChange={value => {setStatus(value); setOffset(0);}}
      options={[{value: '', label: '全部状态'}, ...Object.entries(statuses).map(([value, label]) => ({value, label}))]} style={{width: 180}}/></label></section>
    {error && <Alert type="error" title={error}/>}
    {!data && <p role="status">{loading ? '正在读取反馈…' : '请刷新重试'}</p>}
    {data && <section className="panel list-panel" aria-busy={loading}>
      {!data.items.length ? <Empty>暂无{title}</Empty> : <Table heads={[...(kind === 'website' ? ['网站'] : []), '反馈内容', '联系方式', '状态', '提交时间', '操作']}>
        {data.items.map(item => <tr key={item.id}>{kind === 'website' && <td><strong>{item.site_name}</strong><small><a className="text-link" href={item.url} target="_blank" rel="noopener noreferrer">{item.url} ↗</a></small></td>}
          <td className="support-comment">{item.comment || '申请适配网站'}</td><td>{item.contact || '匿名提交'}</td><td><span className={`badge ${item.status === 'resolved' ? 'good' : ''}`}>{statuses[item.status]}</span></td><td>{time(item.created_at)}</td>
          <td><Button type="link" onClick={() => setDetail(item.id)}>查看 / 处理</Button></td></tr>)}
      </Table>}
      <Pagination total={data.total} count={data.items.length} offset={offset} next={data.next_offset} onPage={setOffset}/>
    </section>}
    {detail && <Review id={detail} onClose={() => setDetail(undefined)} onChanged={reload} onUnauthorized={onUnauthorized}/>}
  </main>;
}
