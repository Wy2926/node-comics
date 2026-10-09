import {useState} from 'react';
import type {Api} from '../api';
import type {Entitlements} from '../types';
import {msg,getLocale} from '../i18n/runtime';
import {QuotaPurchases} from './QuotaPurchases';

export function EntitlementCards({data,api,revision=0}:{data?:Entitlements;api?:Api;revision?:number}){
  const [showPurchases,setShowPurchases]=useState(false);
  if(!data)return <p className="nc-loading" role="status">{msg('正在读取会员权益…')}</p>;
  const date=(value:string)=>new Date(value).toLocaleString(getLocale(),{timeZone:data.timezone});
  return <>
    <section className="nc-rights-grid" aria-label={msg('当前会员权益')}>
      {([['free_quota',msg('免费额度')],['subscription_quota',msg('订阅额度')],['purchase_quota',msg('购买额度')]] as const).map(([key,title])=>{
        const quota=data[key];
        if(!quota)return null;
        const unlimited='unlimited' in quota&&quota.unlimited;
        const ends='resets_at' in quota?quota.resets_at:null;
        return <article className="nc-rights-card" key={key}>
          <div className="nc-rights-label">{title}</div>
          <strong>{unlimited?msg('不限量'):quota.available.toLocaleString(getLocale())}{!unlimited&&<small>{msg('页可用')}</small>}</strong>
          <p>{msg('已用 {0} 页 · 处理中 {1} 页',{'0':quota.used.toLocaleString(getLocale()),'1':quota.reserved.toLocaleString(getLocale())})}</p>
          {ends&&!unlimited&&<p>{msg(key==='free_quota'?'下次恢复 {0}':'本期结束 {0}',{'0':date(ends)})}</p>}
          {key==='purchase_quota'&&<>
            {quota.next_expiry_at?<p>{msg('最早到期 {0}',{'0':date(quota.next_expiry_at)})}</p>:quota.available>0&&<p>{msg('不过期')}</p>}
            {api&&<button className="button quiet small" aria-expanded={showPurchases} aria-controls="account-quota-purchases" onClick={()=>setShowPurchases(value=>!value)}>{showPurchases?msg('收起额度包'):msg('查看额度包')}</button>}
          </>}
        </article>;
      })}
    </section>
    <p className="nc-quota-note">{msg('免费模型先扣免费额度，用完后扣订阅额度，再扣购买额度；高级模型不能扣免费额度。')} · {data.timezone}</p>
    {showPurchases&&api&&<QuotaPurchases api={api} timezone={data.timezone} revision={revision}/>}
  </>;
}
