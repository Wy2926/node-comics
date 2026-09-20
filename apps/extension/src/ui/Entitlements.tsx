import type {Entitlements} from '../types';
import {Icon} from '../icons';

export function EntitlementCards({data}:{data?:Entitlements}) {
  if(!data)return <p className="nc-loading" role="status">正在读取会员权益…</p>;
  const rights=data.modes.redraw,quota=rights.quota;
  const grants=quota?.buckets.filter(b=>b.source==='grant')??[];
  return <section className="nc-rights-grid" aria-label="当前会员权益">
    <article className="nc-rights-card"><div className="nc-rights-label"><Icon name="spark"/>AI 重绘额度</div><strong>{rights.unlimited?'不限量':!rights.allowed?'未开通':quota?.available??0}{rights.allowed&&!rights.unlimited&&<small>页可用</small>}</strong><p>{rights.unlimited?'当前权益内不限量使用':!rights.allowed?'升级 PLUS 或领取有效赠送额度后使用':`已用 ${quota?.used??0} 页 · 处理中 ${quota?.reserved??0} 页`}</p>{quota?.resets_at&&<span className="nc-muted">下次恢复 {new Date(quota.resets_at).toLocaleDateString()}</span>}{grants.length>0&&<details><summary>赠送额度与有效期</summary><ul>{grants.map(b=><li key={b.id}>剩余 {b.available} / {b.granted} 页 · {new Date(b.expires_at).toLocaleString()} 到期</li>)}</ul></details>}</article>
    <article className="nc-rights-card"><div className="nc-rights-label"><Icon name="bolt"/>翻译请求频率</div><strong>{data.image_rate_limit.limit}<small>张 / {data.image_rate_limit.window_seconds} 秒</small></strong><p>按滚动时间窗口计算新增翻译图片</p><span className="nc-muted">跨设备合计，重复请求与结果复用不计入</span></article>
    <article className="nc-rights-card"><div className="nc-rights-label"><Icon name="calendar"/>会员有效期</div><strong className="nc-date-value">{data.plan==='plus'?(data.plus_expires_at?new Date(data.plus_expires_at).toLocaleDateString():'以账户权益为准'):'长期有效'}</strong><p>{data.plan==='plus'?'PLUS 会员权益有效至上述日期':'当前为普通账户'}</p><span className="nc-muted">赠送权益按各自有效期独立生效</span></article>
  </section>;
}
