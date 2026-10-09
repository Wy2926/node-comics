import {useEffect,useRef,useState} from 'react';
import type {Api} from '../api';
import {msg,getLocale} from '../i18n/runtime';
import type {QuotaPurchase,QuotaPurchases as Purchases} from '../types';

export function QuotaPurchaseCard({item,timezone}:{item:QuotaPurchase;timezone:string}){
  const state=msg(({scheduled:'待生效',active:'可用',exhausted:'无可用额度',expired:'已到期',revoked:'已撤销'} as const)[item.state]);
  const date=(value:string)=>new Date(value).toLocaleString(getLocale(),{timeZone:timezone});
  return <article className="nc-purchase-card">
    <header><h3>{item.product_name}</h3><span className="nc-plan-badge" data-state={item.state}>{state}</span></header>
    <div className="nc-purchase-balance"><strong>{item.available.toLocaleString(getLocale())}</strong><span>{msg('页可用')} / {msg('共 {0} 页',{'0':item.granted.toLocaleString(getLocale())})}</span></div>
    <p>{msg('已用 {0} 页 · 处理中 {1} 页',{'0':item.used.toLocaleString(getLocale()),'1':item.reserved.toLocaleString(getLocale())})}</p>
    <dl>
      <div><dt>{msg('生效时间')}</dt><dd>{date(item.starts_at)}</dd></div>
      <div><dt>{msg('有效期')}</dt><dd>{item.expires_at?date(item.expires_at):msg('不过期')}</dd></div>
    </dl>
  </article>;
}

type Page={data:Purchases;cursor:string|null;previous:(string|null)[]};

export function QuotaPurchases({api,timezone,revision=0}:{api:Api;timezone:string;revision?:number}){
  const [page,setPage]=useState<Page>();
  const [loading,setLoading]=useState(false),[error,setError]=useState(false);
  const generation=useRef(0),pending=useRef<AbortController|null>(null);
  const retry=useRef<{cursor:string|null;previous:(string|null)[]}>({cursor:null,previous:[]});
  async function load(cursor:string|null,previous:(string|null)[]){
    if(pending.current)return;
    const current=generation.current,controller=new AbortController();
    pending.current=controller;retry.current={cursor,previous};setLoading(true);setError(false);
    try{
      const data=await api.quotaPurchases(cursor,controller.signal);
      if(current===generation.current&&api.isCurrent())setPage({data,cursor,previous});
    }catch{
      if(current===generation.current&&api.isCurrent()&&!controller.signal.aborted)setError(true);
    }finally{
      if(current===generation.current){pending.current=null;setLoading(false);}
    }
  }
  useEffect(()=>{
    generation.current++;void load(null,[]);
    return()=>{generation.current++;pending.current?.abort();pending.current=null;};
  },[api,revision]);
  return <section id="account-quota-purchases" className="nc-purchases" aria-label={msg('我的额度包')} aria-busy={loading}>
    <div className="nc-section-heading"><div><h2>{msg('我的额度包')}</h2><p className="nc-muted">{msg('按生效时间倒序展示，包含已用完、到期和撤销的记录。')} · {timezone}</p></div></div>
    {error&&<p className="nc-error" role="alert">{msg('暂时无法读取额度包，请重试。')} <button className="text-link" onClick={()=>void load(retry.current.cursor,retry.current.previous)}>{msg('重试')}</button></p>}
    {loading&&<p className="nc-muted" role="status">{msg('正在读取额度包…')}</p>}
    {page&&!page.data.items.length&&<p className="nc-empty-copy">{msg('暂无已购额度包')}</p>}
    {page&&<>
      <div className="nc-purchase-grid">{page.data.items.map(item=><QuotaPurchaseCard key={item.id} item={item} timezone={timezone}/>)}</div>
      {(page.previous.length>0||page.data.next_cursor)&&<div className="nc-pagination">
        <button className="button secondary small" disabled={loading||!page.previous.length} onClick={()=>void load(page.previous.at(-1)!,page.previous.slice(0,-1))}>{msg('上一页')}</button>
        <button className="button secondary small" disabled={loading||!page.data.next_cursor} onClick={()=>void load(page.data.next_cursor,[...page.previous,page.cursor])}>{msg('下一页')}</button>
      </div>}
    </>}
  </section>;
}
