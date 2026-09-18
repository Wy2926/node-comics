import type {Entitlements} from '../types';
import {modeLabels} from '../types';

export function EntitlementCards({data}:{data?:Entitlements}) {
  if(!data)return <p className="nc-loading">正在读取会员权益…</p>;
  return <section aria-label="会员权益">
    <div className="nc-section-heading"><h2>{data.plan==='plus'?'PLUS 会员':'普通用户'}</h2><span>最多同时翻译 {data.plan==='plus'?10:3} 张</span></div>
    {data.plan==='plus'&&data.plus_expires_at&&<p className="nc-muted">会员有效至 {new Date(data.plus_expires_at).toLocaleString()} · 重绘额度按会员月刷新，剩余不累积</p>}
    <div className="nc-stat-grid nc-entitlements-grid">{(['redraw'] as const).map(mode=>{
      const rights=data.modes[mode],quota=rights.quota;
      return <article className="nc-stat" key={mode}><span>{modeLabels[mode]}</span>
        <b>{rights.unlimited?'不限量':!rights.allowed?'PLUS 专享':quota?.available??0}{rights.allowed&&!rights.unlimited&&<small>页可用</small>}</b>
        <p>{rights.unlimited?'不消耗重绘与赠送额度':!rights.allowed?'有效重绘赠送额度也可提供临时权限':`已用 ${quota?.used??0} 页 · 预占 ${quota?.reserved??0} 页`}</p>
        {quota?.resets_at&&<p>基础额度恢复：{new Date(quota.resets_at).toLocaleString()}</p>}
        {!!quota?.buckets.some(b=>b.source==='grant')&&<details><summary>查看赠送额度与到期时间</summary><ul>{quota.buckets.filter(b=>b.source==='grant').map(b=><li key={b.id}>剩余 {b.available} / {b.granted} 页 · {new Date(b.expires_at).toLocaleString()} 到期</li>)}</ul></details>}
      </article>;
    })}</div>
  </section>;
}
