import {msg,getLocale} from '../i18n/runtime';
import type {Entitlements} from '../types';
import {Icon} from '../icons';

export function EntitlementCards({data}:{data?:Entitlements}) {
  if(!data)return <p className="nc-loading" role="status">{msg("正在读取会员权益…")}</p>;
  const rights=data.modes.redraw,quota=rights.quota;
  const grants=quota?.buckets.filter(b=>b.source==='grant')??[];
  return <section className="nc-rights-grid" aria-label={msg("当前会员权益")}>
    <article className="nc-rights-card"><div className="nc-rights-label"><Icon name="spark"/>{msg("AI 重绘额度")}</div><strong>{rights.unlimited?msg("不限量"):!rights.allowed?msg("未开通"):quota?.available??0}{rights.allowed&&!rights.unlimited&&<small>{msg("页可用")}</small>}</strong><p>{rights.unlimited?msg("当前权益内不限量使用"):!rights.allowed?msg("升级 PLUS 或领取有效赠送额度后使用"):msg("已用 {0} 页 · 处理中 {1} 页", {"0": quota?.used??0, "1": quota?.reserved??0})}</p>{quota?.resets_at&&<span className="nc-muted">{msg("下次恢复 {0}", {"0": new Date(quota.resets_at).toLocaleDateString(getLocale())})}</span>}{grants.length>0&&<details><summary>{msg("赠送额度与有效期")}</summary><ul>{grants.map(b=><li key={b.id}>{msg("剩余 {0} / {1} 页 · {2} 到期", {"0": b.available, "1": b.granted, "2": new Date(b.expires_at).toLocaleString(getLocale())})}</li>)}</ul></details>}</article>
    <article className="nc-rights-card"><div className="nc-rights-label"><Icon name="bolt"/>{msg("翻译请求频率")}</div><strong>{data.image_rate_limit.limit}<small>{msg("张 / {0} 秒", {"0": data.image_rate_limit.window_seconds})}</small></strong><p>{msg("按滚动时间窗口计算新增翻译图片")}</p><span className="nc-muted">{msg("跨设备合计，重复请求与结果复用不计入")}</span></article>
    <article className="nc-rights-card"><div className="nc-rights-label"><Icon name="calendar"/>{msg("会员有效期")}</div><strong className="nc-date-value">{data.plan==='plus'?(data.plus_expires_at?new Date(data.plus_expires_at).toLocaleDateString(getLocale()):msg("以账户权益为准")):msg("长期有效")}</strong><p>{data.plan==='plus'?msg("PLUS 会员权益有效至上述日期"):msg("当前为普通账户")}</p><span className="nc-muted">{msg("赠送权益按各自有效期独立生效")}</span></article>
  </section>;
}
