import {useState} from 'react';
import {DataTable, ResourceError, useAdminResource, type Row} from './AdminResource';
import {Stat, time} from './ui';
import {billingStatus} from './billing';

type Statistics = {jobs: Row[]; reuse: Row[]; text_calls: Row[]; payments: Row[]; text_calls_truncated: boolean; generated_at: string};
export function StatisticsPage({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  const [query, setQuery] = useState('days=7');
  const {data, error, busy, reload} = useAdminResource<Statistics>(`/v1/admin/operations/statistics?${query}`, onUnauthorized);
  return <main id="main" tabIndex={-1} className="admin-surface"><div className="page-heading"><div><p className="eyebrow">USAGE & COST</p><h1>用量与成本</h1><p className="muted">按 UTC 日期查看任务结果、文本调用计量、结果复用和订单金额。</p></div><button className="secondary" onClick={reload} disabled={busy}>刷新统计</button></div>
    <form className="filters filter-form" onSubmit={event => {event.preventDefault(); const next = new URLSearchParams();
      for (const [key, value] of new FormData(event.currentTarget)) if (String(value).trim()) next.set(key, String(value).trim()); if (next.toString() === query) reload(); else setQuery(next.toString());}}>
      <label>时间范围<select name="days" defaultValue="7"><option value="1">今天</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option></select></label>
      <label>文本供应商 ID<input name="provider_id" maxLength={80}/></label><label>文本模型<input name="model" maxLength={120}/></label><button className="primary">查询</button></form>
    <ResourceError error={error} stale={!!data}/>{busy && <p role="status">正在汇总统计…</p>}{data && <>
      <div className="stats-grid"><Stat title="已结束任务" value={String(data.jobs.reduce((sum,row)=>sum+Number(row.count),0))} note="所选时间范围 · 含成功与失败"/><Stat title="新授予复用" value={String(data.reuse.reduce((sum,row)=>sum+Number(row.access_grants),0))} note="已有译图访问授权"/><Stat title="文本调用" value={`${data.text_calls_truncated ? '≥ ' : ''}${data.text_calls.reduce((sum,row)=>sum+Number(row.calls),0)}`} note="应用供应商与模型筛选"/><Stat title="未知消耗调用" value={`${data.text_calls_truncated ? '≥ ' : ''}${data.text_calls.reduce((sum,row)=>sum+Number(row.unknown_calls),0)}`} note="成本仍待核实"/></div>
      <section className="panel"><h2>任务完成情况</h2><DataTable rows={data.jobs} columns={[{key:'day',title:'日期'},{key:'mode',title:'模式'},{key:'status',title:'终态'},{key:'count',title:'数量'},{key:'avg_seconds',title:'平均总耗时（秒）'}]}/></section>
      <section className="panel"><h2>文本调用成本</h2><p className="panel-note">供应商与模型筛选仅作用于本表。金额单位为人民币，包含估算及未知消耗预占，不代表供应商账单已对账。</p>
        {data.text_calls_truncated && <p className="attention">分组超过 2000 条，请缩短时间范围或指定供应商／模型。</p>}
        <DataTable rows={data.text_calls} columns={[{key:'day',title:'日期'},{key:'provider_id',title:'供应商'},{key:'model',title:'模型'},{key:'calls',title:'调用次数'},{key:'accounted_micros',title:'计量金额',format:'money'},
          {key:'unknown_calls',title:'未知消耗'},{key:'estimated_calls',title:'估算消耗'},{key:'failed_calls',title:'错误调用'}]}/></section>
      <section className="panel"><h2>已有结果复用</h2><DataTable rows={data.reuse} columns={[{key:'day',title:'日期'},{key:'access_grants',title:'新增复用授权'}]}/><p className="panel-note">统计新授予的已有结果访问，不是浏览次数，也不产生新的计算任务。</p></section>
      <section className="panel"><h2>订单原金额</h2><DataTable rows={data.payments} columns={[{key:'day',title:'创建日期'},{key:'provider',title:'渠道'},{key:'environment',title:'环境'},{key:'status',title:'当前状态',formatter:value=>billingStatus(value == null ? null : String(value))},{key:'orders',title:'订单数'},{key:'order_amount',title:'原金额',format:'currency'}]}/>
        <p className="panel-note">按币种独立统计订单原金额；不扣除退款、争议或手续费，不能作为净收入。</p></section>
      <p className="footnote">统计时间 {time(data.generated_at)}。</p></>}
  </main>;
}
