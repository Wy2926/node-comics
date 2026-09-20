import {msg,getLocale} from '../i18n/runtime';
import type {Entitlements,Mode,ModeEntitlement} from '../types';
import {Icon} from '../icons';

function QuotaCard({mode,rights,timezone}:{mode:Mode;rights:ModeEntitlement;timezone:string}) {
  const quota=rights.quota;
  const title=mode==='classic'?msg('常规翻译额度'):msg('AI 重绘额度');
  const grants=quota?.buckets.filter(b=>b.source==='grant')??[];
  return <article className="nc-rights-card nc-quota-card">
    <div className="nc-rights-label"><span className="nc-quota-icon"><Icon name={mode==='classic'?'book':'spark'}/></span>{title}</div>
    <strong>{rights.unlimited?msg('不限量'):!rights.allowed?msg('未开通'):quota?.available??0}{rights.allowed&&!rights.unlimited&&<small>{msg('页可用')}</small>}</strong>
    <p>{rights.unlimited?msg('当前权益内不限量使用'):!rights.allowed?msg('升级 PLUS 或领取有效赠送额度后使用'):msg('已用 {0} 页 · 处理中 {1} 页',{'0':quota?.used??0,'1':quota?.reserved??0})}</p>
    {rights.allowed&&!rights.unlimited&&quota&&quota.granted>0&&<progress className="nc-quota-meter" aria-label={title} value={Math.max(0,Math.min(quota.available,quota.granted))} max={quota.granted}/>}
    {quota?.resets_at&&!rights.unlimited&&<span className="nc-muted nc-quota-reset">{msg('下次恢复 {0}',{'0':new Date(quota.resets_at).toLocaleString(getLocale(),{timeZone:timezone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})})} · {timezone}</span>}
    {grants.length>0&&<details><summary>{msg('赠送额度与有效期')}</summary><ul>{grants.map(b=><li key={b.id}>{msg('剩余 {0} / {1} 页 · {2} 到期',{'0':b.available,'1':b.granted,'2':new Date(b.expires_at).toLocaleString(getLocale())})}</li>)}</ul></details>}
  </article>;
}

export function EntitlementCards({data}:{data?:Entitlements}) {
  if(!data)return <p className="nc-loading" role="status">{msg('正在读取会员权益…')}</p>;
  return <section className="nc-rights-grid" aria-label={msg('当前会员权益')}>
    <QuotaCard mode="classic" rights={data.modes.classic} timezone={data.timezone}/>
    <QuotaCard mode="redraw" rights={data.modes.redraw} timezone={data.timezone}/>
    <article className="nc-rights-card nc-rate-card">
      <div><div className="nc-rights-label"><Icon name="bolt"/>{msg('翻译请求频率')}</div><strong>{data.image_rate_limit.limit}<small>{msg('张 / {0} 秒',{'0':data.image_rate_limit.window_seconds})}</small></strong></div>
      <div><p>{msg('按滚动时间窗口计算新增翻译图片')}</p><span className="nc-muted">{msg('跨设备合计，重复请求与结果复用不计入')}</span></div>
    </article>
  </section>;
}
