import {useEffect,useState} from 'react';
import type {Api} from '../api';
import {type UsageSummary,modeLabels} from '../types';
import {Icon} from '../icons';
import {EntitlementCards} from './Entitlements';

export function UsagePage({api,onLogin}:{api:Api;onLogin:()=>void}) {
  const [days,setDays]=useState(7),[data,setData]=useState<UsageSummary>();
  const [error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  useEffect(()=>{
    if(!api.token)return;
    let live=true,timer:ReturnType<typeof setTimeout>;
    setData(undefined);
    async function fetchSummary(){
      if(!document.hidden)try{const result=await api.usageSummary(days,timezone);if(live&&api.isCurrent()){setData(result);setError('');}}
      catch(e){if(live&&api.isCurrent())setError((e as Error).message);}
      if(live)timer=setTimeout(fetchSummary,30000);
    }
    void fetchSummary();return()=>{live=false;clearTimeout(timer);};
  },[api,days,timezone,refresh]);
  const max=Math.max(1,...(data?.days.map(d=>d.delivered)??[]));
  return <div>
    <div className="nc-page-heading"><div><span className="nc-eyebrow">YOUR TRANSLATION ACTIVITY</span><h1>用量统计</h1><p>查看翻译记录与会员权益。</p></div>
      {api.token&&<div className="nc-inline"><select aria-label="统计时间范围" value={days} onChange={e=>setDays(Number(e.target.value))}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option></select><button className="icon-button" aria-label="刷新用量" onClick={()=>setRefresh(v=>v+1)}><Icon name="refresh"/></button></div>}
    </div>
    {!api.token?<div className="nc-empty"><Icon name="book" size={36}/><h2>登录后查看用量</h2><p>常规与重绘分别计量，成功交付后扣减有限额度。</p><button className="button primary" onClick={onLogin}>登录账户</button></div>:<>
      {error&&<p className="nc-error" role="alert">{error}<button className="text-link" onClick={()=>setRefresh(v=>v+1)}>重试</button></p>}
      {!data&&!error?<p className="nc-loading">正在汇总用量…</p>:data&&<>
        <EntitlementCards data={data.entitlements}/><p className="nc-muted">当前权益与额度不受日期筛选影响。</p>
        <div className="nc-stat-grid">
          <div className="nc-stat"><span>本期常规交付</span><b>{data.by_mode.classic??0}<small>页</small></b><p>其中 PLUS 权益内交付 {data.included_delivered} 页</p></div>
          <div className="nc-stat"><span>本期重绘交付</span><b>{data.by_mode.redraw??0}<small>页</small></b><p>扣减重绘额度 {data.quota_used.redraw??0} 页</p></div>
          <div className="nc-stat"><span>本期未扣量交付</span><b>{data.free_delivered}<small>页</small></b><p>包括部分完成和释放预占后的补交付</p></div>
        </div>
        <div className="nc-usage-charts"><section className="nc-chart-card"><h2>每日交付页数</h2><p>{data.start_date} — {data.end_date} · {data.timezone}</p>
          <div className="nc-bar-chart" role="img" aria-label={`最近 ${days} 天交付 ${data.delivered} 页`}><div className="nc-chart-bars">{data.days.map(d=><div className="nc-chart-column" key={d.date} title={`${d.date}：常规 ${d.classic} 页、重绘 ${d.redraw} 页`}><div className="nc-chart-bar" style={{height:`${d.delivered/max*100}%`}}/><span>{days<=7?d.date.slice(5):''}</span></div>)}</div></div>
          {!data.delivered&&<p className="nc-chart-zero">本期暂无交付</p>}
          <details className="nc-chart-data"><summary>查看每日数值</summary><div className="nc-data-table"><table><thead><tr><th>日期</th><th>常规页数</th><th>重绘页数</th><th>交付合计</th></tr></thead><tbody>{data.days.map(d=><tr key={d.date}><td>{d.date}</td><td>{d.classic}</td><td>{d.redraw}</td><td>{d.delivered}</td></tr>)}</tbody></table></div></details>
        </section><section className="nc-chart-card"><h2>翻译方式分布</h2><p>按实际交付页数，包含 PLUS 常规翻译</p>
          {(['classic','redraw'] as const).map(mode=><div className="nc-mode-usage" key={mode}><div><span>{modeLabels[mode]}</span><b>{data.by_mode[mode]??0} 页</b></div><div className="nc-progress"><i style={{width:`${(data.by_mode[mode]??0)/Math.max(1,data.delivered)*100}%`}}/></div>{mode==='redraw'&&<p>使用重绘额度 {data.quota_used.redraw??0} 页</p>}</div>)}
        </section></div>
        <p className="nc-muted">按 {timezone} 的自然日展示交付，不重复计算复用结果。额度按任务受理时的记录结算。</p>
      </>}
    </>}
  </div>;
}
