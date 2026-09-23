import {useEffect, useState} from 'react';
import {useBillingResource} from './BillingShared';
import {Empty, Pagination, Table, time} from './ui';

type SiteRequest = {id: string; site_name: string; url: string; comment: string; contact: string; created_at: string};
type Page = {items: SiteRequest[]; total: number; next_offset: number | null};

export function SupportRequestsPage({kind, onUnauthorized}: {kind: 'website' | 'plugin'; onUnauthorized: (message: string) => void}) {
  const title = kind === 'website' ? '网站适配申请' : '插件反馈';
  const [offset, setOffset] = useState(0);
  const {data, loading, error, reload} = useBillingResource<Page>(`/v1/admin/support-requests?kind=${kind}&offset=${offset}&limit=25`, onUnauthorized);
  useEffect(() => {document.title = `${title} · Node Comics 管理后台`;}, [title]);
  return <main id="main" tabIndex={-1}>
    <div className="page-heading"><div><p className="eyebrow">{kind === 'website' ? 'WEBSITE REQUESTS' : 'PLUGIN FEEDBACK'}</p><h1>{title}</h1><p className="muted">查看读者匿名提交的内容与选填联系方式，按提交时间倒序排列。</p></div><button className="secondary" disabled={loading} onClick={() => void reload()}>{loading ? '正在刷新…' : '↻ 刷新'}</button></div>
    {error && <p className="error" role="alert">{error} 请刷新重试。</p>}
    {loading && <p className="loading" role="status">正在读取反馈…</p>}
    {data && <section className="panel list-panel" aria-busy={loading}>
      {!data.items.length ? <Empty>暂无{title}</Empty> : <Table heads={[...(kind === 'website' ? ['网站'] : []), '反馈内容', '联系方式', '提交时间', '回执编号']}>
        {data.items.map(item => <tr key={item.id}>{kind === 'website' && <td><strong>{item.site_name}</strong><br/><a className="text-link" href={item.url} target="_blank" rel="noopener noreferrer" style={{overflowWrap: 'anywhere'}}>{item.url} ↗</a></td>}<td style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: 400}}>{item.comment || '未填写'}</td><td style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: 240}}>{item.contact || '未填写'}</td><td>{time(item.created_at)}</td><td><code>{item.id}</code><br/><span className="muted">匿名提交</span></td></tr>)}
      </Table>}
      <Pagination total={data.total} count={data.items.length} offset={offset} next={data.next_offset} onPage={setOffset}/>
    </section>}
  </main>;
}
