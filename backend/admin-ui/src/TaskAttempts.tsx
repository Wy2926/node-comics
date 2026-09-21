import {useEffect, useState} from 'react';
import {authError, errorText, request} from './api';
import {Empty, label, Pagination, Table, time} from './ui';

type Attempt = {id: string; provider_id: string; request_id: string | null; started_at: string; call_started_at: string | null;
  completed_at: string | null; heartbeat_at: string | null; lease_expires_at: string; cost_state: string;
  usage: Record<string, unknown> | null; error_code: string | null; recovered: boolean};
type Attempts = {items: Attempt[]; total: number; next_offset: number | null};

export function TaskAttempts({jobId, refreshKey, onUnauthorized}: {
  jobId: string; refreshKey?: string; onUnauthorized?: (message: string) => void;
}) {
  const [data, setData] = useState<Attempts>(), [error, setError] = useState('');
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0), [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError('');
    request<Attempts>(`/v1/admin/jobs/${encodeURIComponent(jobId)}/attempts?offset=${offset}&limit=25`, {signal: controller.signal})
      .then(result => {if (!controller.signal.aborted) setData(result);})
      .catch(failure => {if (!controller.signal.aborted) {
        if (authError(failure) && onUnauthorized) onUnauthorized(errorText(failure)); else setError(errorText(failure));
      }})
      .finally(() => {if (!controller.signal.aborted) setBusy(false);});
    return () => controller.abort();
  }, [jobId, offset, revision, refreshKey, onUnauthorized]);
  return <section aria-label="供应商请求尝试" aria-busy={busy}>
    <h3 className="detail-heading">供应商请求尝试 <span>{data?.total ?? '—'} 次</span></h3>
    <p className="panel-note">请求编号用于向供应商核实。未知消耗保留原记录；人工交付结论不代表供应商账单已核对。</p>
    {error && <p className="error" role="alert">{error} <button className="text-link" disabled={busy} onClick={() => setRevision(n => n + 1)}>重试读取</button></p>}
    {!data && busy && <p role="status">正在读取请求记录…</p>}
    {data && (data.items.length ? <>
      <Table heads={['供应商 / 请求编号', '开始 / 上游发送', '完成 / 心跳', '计量 / 结果']}>{data.items.map(row => <tr key={row.id}>
        <td><b>{row.provider_id}</b><small><code>{row.request_id || '尚无上游请求编号'}</code></small><small>尝试 <code>{row.id}</code></small></td>
        <td>{time(row.started_at)}<small>{row.call_started_at ? time(row.call_started_at) : '尚未发送上游请求'}</small></td>
        <td>{row.completed_at ? time(row.completed_at) : '尚未结束'}<small>心跳 {time(row.heartbeat_at)}</small><small>租约期限 {time(row.lease_expires_at)}</small></td>
        <td>{label(row.cost_state)}<small>{row.error_code || '无错误记录'}{row.recovered && ' · 已恢复'}</small>
          {row.usage && <details><summary>调用用量</summary><pre className="admin-json">{JSON.stringify(row.usage, null, 2)}</pre></details>}</td>
      </tr>)}</Table>
      <Pagination total={data.total} count={data.items.length} offset={offset} next={data.next_offset} onPage={value => {if (!busy) setOffset(value);}}/>
    </> : <Empty>尚无供应商请求尝试</Empty>)}
  </section>;
}
