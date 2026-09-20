import {msg} from '../i18n/runtime';
import {useEffect,useState} from 'react';
import type {Api} from '../api';
import {type UsageSummary,type Entitlements,modeLabels} from '../types';
import {Icon} from '../icons';

export function AccountUsage({api,onLogin,onEntitlements}:{api:Api;onLogin:()=>void;onEntitlements:(value:Entitlements)=>void}) {
  const [days,setDays]=useState(7),[data,setData]=useState<UsageSummary>();
  const [error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  useEffect(()=>{
    if(!api.token)return;
    let live=true,timer:ReturnType<typeof setTimeout>;
    setData(undefined);setError('');
    async function fetchSummary(){
      if(!document.hidden)try{const result=await api.usageSummary(days,timezone);if(live&&api.isCurrent()){setData(result);onEntitlements(result.entitlements);setError('');}}
      catch(e){if(live&&api.isCurrent())setError((e as Error).message);}
      if(live)timer=setTimeout(fetchSummary,30000);
    }
    void fetchSummary();return()=>{live=false;clearTimeout(timer);};
  },[api,days,timezone,refresh,onEntitlements]);
  const max=Math.max(1,...(data?.days.map(d=>d.delivered)??[]));
  return <div>
    <div className="nc-section-heading"><div><h2><Icon name="chart"/>{msg("用量统计")}</h2><p className="nc-muted">{msg("查看所选时段的翻译交付与使用情况。")}</p></div>
      {api.token&&<div className="nc-inline"><select aria-label={msg("统计时间范围")} value={days} onChange={e=>setDays(Number(e.target.value))}><option value={7}>{msg("最近 7 天")}</option><option value={30}>{msg("最近 30 天")}</option><option value={90}>{msg("最近 90 天")}</option></select><button className="icon-button" aria-label={msg("刷新用量")} onClick={()=>setRefresh(v=>v+1)}><Icon name="refresh"/></button></div>}
    </div>
    {!api.token?<div className="nc-empty"><Icon name="book" size={36}/><h2>{msg("登录后查看用量")}</h2><p>{msg("常规与重绘分别计量，成功交付后扣减有限额度。")}</p><button className="button primary" onClick={onLogin}>{msg("登录账户")}</button></div>:<>
      {error&&<p className="nc-error" role="alert">{error}<button className="text-link" onClick={()=>setRefresh(v=>v+1)}>{msg("重试")}</button></p>}
      {!data&&!error?<p className="nc-loading">{msg("正在汇总用量…")}</p>:data&&<>
        <div className="nc-stat-grid">
          <div className="nc-stat"><span><Icon name="book" size={17}/>{msg("常规交付")}</span><b>{data.by_mode.classic??0}<small>{msg("页")}</small></b><p>{msg("其中 PLUS 权益内交付 {0} 页", {"0": data.included_delivered})}</p></div>
          <div className="nc-stat"><span><Icon name="spark" size={17}/>{msg("重绘交付")}</span><b>{data.by_mode.redraw??0}<small>{msg("页")}</small></b><p>{msg("扣减重绘额度 {0} 页", {"0": data.quota_used.redraw??0})}</p></div>
          <div className="nc-stat"><span><Icon name="check" size={17}/>{msg("未扣量交付")}</span><b>{data.free_delivered}<small>{msg("页")}</small></b><p>{msg("包括部分完成和释放预占后的补交付")}</p></div>
        </div>
        <div className="nc-usage-charts"><section className="nc-chart-card"><h2>{msg("每日交付页数")}</h2><p>{data.start_date} — {data.end_date} · {data.timezone}</p>
          <div className="nc-bar-chart" role="img" aria-label={msg("最近 {0} 天交付 {1} 页", {"0": days, "1": data.delivered})}><div className="nc-chart-bars">{data.days.map(d=><div className="nc-chart-column" key={d.date} title={msg("{0}：常规 {1} 页、重绘 {2} 页", {"0": d.date, "1": d.classic, "2": d.redraw})}><div className="nc-chart-bar" style={{height:`${d.delivered/max*100}%`}}/><span>{days<=7?d.date.slice(5):''}</span></div>)}</div></div>
          {!data.delivered&&<p className="nc-chart-zero">{msg("所选时段暂无交付")}</p>}
          <details className="nc-chart-data"><summary>{msg("查看每日数值")}</summary><div className="nc-data-table"><table><thead><tr><th>{msg("日期")}</th><th>{msg("常规页数")}</th><th>{msg("重绘页数")}</th><th>{msg("交付合计")}</th></tr></thead><tbody>{data.days.map(d=><tr key={d.date}><td>{d.date}</td><td>{d.classic}</td><td>{d.redraw}</td><td>{d.delivered}</td></tr>)}</tbody></table></div></details>
        </section><section className="nc-chart-card"><h2>{msg("翻译方式分布")}</h2><p>{msg("按实际交付页数，包含 PLUS 常规翻译")}</p>
          {(['classic','redraw'] as const).map(mode=><div className="nc-mode-usage" key={mode}><div><span>{modeLabels[mode]}</span><b>{msg("{0} 页", {"0": data.by_mode[mode]??0})}</b></div><div className="nc-progress"><i style={{width:`${(data.by_mode[mode]??0)/Math.max(1,data.delivered)*100}%`}}/></div>{mode==='redraw'&&<p>{msg("使用重绘额度 {0} 页", {"0": data.quota_used.redraw??0})}</p>}</div>)}
        </section></div>
        <p className="nc-muted">{msg("按 {0} 的自然日展示交付，不重复计算复用结果。额度按任务受理时的记录结算。", {"0": timezone})}</p>
      </>}
    </>}
  </div>;
}
