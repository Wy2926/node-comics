import {msg,getLocale} from '../i18n/runtime';
import type {Entitlements,ModeEntitlement} from '../types';
import {Icon} from '../icons';

function QuotaCard({rights,timezone}:{rights:ModeEntitlement;timezone:string}) {
  const quota=rights.quota;
  const title=msg('常规翻译额度');
  const grants=quota?.buckets.filter(b=>b.source==='grant')??[];
  return <article className="nc-rights-card nc-quota-card">
    <div className="nc-rights-label"><span className="nc-quota-icon"><Icon name="book"/></span>{title}</div>
    <strong>{rights.unlimited?msg('不限量'):!rights.allowed?msg('未开通'):quota?.available??0}{rights.allowed&&!rights.unlimited&&<small>{msg('页可用')}</small>}</strong>
    <p>{rights.unlimited?msg('常规翻译不设日／月累计上限'):!rights.allowed?msg('查看当前账户权益或升级会员后使用'):msg('已用 {0} 页 · 处理中 {1} 页',{'0':quota?.used??0,'1':quota?.reserved??0})}</p>
    {rights.allowed&&!rights.unlimited&&quota&&quota.granted>0&&<progress className="nc-quota-meter" aria-label={title} value={Math.max(0,Math.min(quota.available,quota.granted))} max={quota.granted}/>}
    {quota?.resets_at&&!rights.unlimited&&<span className="nc-muted nc-quota-reset">{msg('下次恢复 {0}',{'0':new Date(quota.resets_at).toLocaleString(getLocale(),{timeZone:timezone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})})} · {timezone}</span>}
    {grants.length>0&&<details><summary>{msg('赠送额度与有效期')}</summary><ul>{grants.map(b=><li key={b.id}>{b.expires_at?msg('剩余 {0} / {1} 页 · {2} 到期',{'0':b.available,'1':b.granted,'2':new Date(b.expires_at).toLocaleString(getLocale())}):<>{b.available} / {b.granted} {msg('页可用')}</>}</li>)}</ul></details>}
  </article>;
}

export function EntitlementCards({data}:{data?:Entitlements}) {
  if(!data)return <p className="nc-loading" role="status">{msg('正在读取会员权益…')}</p>;
  return <section className="nc-rights-grid" aria-label={msg('当前会员权益')}>
    {data.free_quota&&data.subscription_quota?<>{([['free_quota',msg('免费额度')],['subscription_quota',msg('订阅额度')]] as const).map(([key,title])=>{const quota=data[key]!;const unlimited='unlimited' in quota&&quota.unlimited;return <article className="nc-rights-card nc-quota-card" key={key}><div className="nc-rights-label">{title}</div><strong>{unlimited?msg('不限量'):quota.available}{!unlimited&&<small>{msg('页可用')}</small>}</strong><p>{msg('已用 {0} 页 · 处理中 {1} 页',{'0':quota.used,'1':quota.reserved})}</p><p>{msg('免费模型先扣免费额度，用完后扣订阅额度，再扣购买额度；高级模型不能扣免费额度。')}</p></article>;})}</>:<QuotaCard rights={data.modes.classic} timezone={data.timezone}/>}
    <article className="nc-rights-card nc-rate-card">
      <div><div className="nc-rights-label"><Icon name="bolt"/>{msg('翻译请求频率')}</div><div className="nc-rate-limits">
        <strong>{data.image_rate_limit.limit}<small>{msg('张 / {0} 秒',{'0':data.image_rate_limit.window_seconds})}</small></strong>
        {data.hourly_image_rate_limit&&<strong>{data.hourly_image_rate_limit.limit}<small>{msg('张 / {0} 秒',{'0':data.hourly_image_rate_limit.window_seconds})}</small></strong>}
      </div></div>
      <div><p>{msg('按滚动时间窗口计算新增翻译图片')}</p><span className="nc-muted">{msg('跨设备合计，重复请求与结果复用不计入')}</span></div>
      {data.service_plan&&<p>{msg('当前服务档位：{0}',{'0':data.service_plan==='free'?msg('普通用户'):data.service_plan})}</p>}
    </article>
    {data.purchase_quota&&<article className="nc-rights-card nc-quota-card">
      <div className="nc-rights-label">{msg('购买额度')}</div>
      <strong>{data.purchase_quota.available}<small>{msg('页可用')}</small></strong>
      <p>{msg('购买额度剩余 {0} 页 · 处理中 {1} 页',{'0':data.purchase_quota.available,'1':data.purchase_quota.reserved})}</p>
      {data.purchase_quota.next_expiry_at?<p>{msg('最早到期 {0}',{'0':new Date(data.purchase_quota.next_expiry_at).toLocaleString(getLocale(),{timeZone:data.timezone})})} · {data.timezone}</p>:data.purchase_quota.available>0&&<p>{msg('不过期')}</p>}
      <p>{msg('订阅额度用完后可扣购买额度；购买额度有效期仍继续计算。')}</p>
    </article>}
  </section>;
}
