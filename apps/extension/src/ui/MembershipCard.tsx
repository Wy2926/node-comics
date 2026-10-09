import {useEffect,useRef,useState} from 'react';
import {msg,getLocale} from '../i18n/runtime';
import type {Api} from '../api';
import type {Entitlements} from '../types';
import {type BillingStatus,paymentUrl,hasManagedSubscription,offerAmount,pricingUrl} from '../billing';
import {Icon} from '../icons';

export function MembershipCard({api,loggedIn,rights,onEntitlements,notify}:{api:Api;loggedIn:boolean;rights?:Entitlements;onEntitlements:(value:Entitlements)=>void;notify:(message:string)=>void}) {
  const [billing,setBilling]=useState<BillingStatus>();
  const [opening,setOpening]=useState(false);
  const [refreshing,setRefreshing]=useState(false);
  const [error,setError]=useState('');
  const [refreshError,setRefreshError]=useState('');
  const [confirmCancel,setConfirmCancel]=useState(false);
  const generation=useRef(0),openingRef=useRef(false),refreshingRef=useRef(false);
  const lastAutomaticRead=useRef(0),returnedFromPayment=useRef(false);
  const subscription=billing?.subscription,gift=billing?billing.gift:rights?.gift;
  const member=loggedIn&&!!rights&&rights.plan!=='free';
  const managed=!!subscription&&hasManagedSubscription(subscription.status,billing?.entitlement_expires_at);
  const title=managed?subscription.price.name:gift&&gift.state!=='expired'?msg('会员赠送'):msg('当前会员权益');
  const expiresAt=billing?.entitlement_expires_at??rights?.plus_expires_at;
  const date=(value:string)=>new Date(value).toLocaleString(getLocale());
  useEffect(()=>{
    const current=++generation.current;
    setBilling(undefined);setError('');setRefreshError('');setOpening(false);setRefreshing(false);setConfirmCancel(false);
    openingRef.current=false;refreshingRef.current=false;returnedFromPayment.current=false;
    lastAutomaticRead.current=Date.now();
    if(loggedIn)void api.billingStatus().then(value=>{if(current===generation.current)setBilling(value);}).catch(()=>{if(current===generation.current)setRefreshError(msg('暂时无法读取订阅，请重试。'));});
    return()=>{generation.current++;};
  },[api,loggedIn]);
  async function refresh(manual=true){
    if(!loggedIn||refreshingRef.current||openingRef.current)return;
    const reconcile=manual||returnedFromPayment.current;
    if(!manual&&!reconcile&&Date.now()-lastAutomaticRead.current<30000)return;
    const current=generation.current;
    refreshingRef.current=true;lastAutomaticRead.current=Date.now();returnedFromPayment.current=false;
    setRefreshing(true);setRefreshError('');
    try{
      const status=await api.billingStatus(reconcile);
      if(current!==generation.current)return;
      setBilling(status);
      if(status.enabled&&reconcile){
        const result=await api.syncBilling();
        if(current!==generation.current)return;
        setBilling(result.billing);onEntitlements(result.entitlements);
      }else if(manual){
        const value=await api.entitlements(true);if(current===generation.current)onEntitlements(value);
      }
      if(current===generation.current&&manual)notify(msg('权益已刷新'));
    }catch{if(current===generation.current)setRefreshError(msg('暂时无法读取订阅，请重试。'));}
    finally{if(current===generation.current){refreshingRef.current=false;setRefreshing(false);}}
  }
  useEffect(()=>{
    const focus=()=>{if(loggedIn&&!document.hidden)void refresh(false);};
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[api,loggedIn]);
  async function openPortal(){
    if(openingRef.current||!billing?.enabled||!managed||!subscription)return;
    const current=generation.current;openingRef.current=true;setOpening(true);setError('');
    const extension=typeof chrome!=='undefined'&&!!chrome.runtime?.id;
    let popup:Window|null=null;
    try{
      if(!extension){popup=window.open('about:blank','_blank');if(!popup)throw Error('popup blocked');popup.opener=null;}
      const result=await api.billingPortal(subscription.provider);
      if(current!==generation.current){popup?.close();return;}
      if(result.provider!==subscription.provider)throw Error('provider mismatch');
      const url=paymentUrl(result.url,subscription.provider,true);
      if(extension)await chrome.tabs.create({url});
      else popup!.location.replace(url);
      returnedFromPayment.current=true;
    }catch{popup?.close();if(current===generation.current)setError(msg('暂时无法打开支付页面，请重试。'));}
    finally{if(current===generation.current){openingRef.current=false;setOpening(false);}}
  }
  async function cancelRenewal(){
    if(openingRef.current||!subscription?.auto_renew||!subscription.can_cancel)return;
    const current=generation.current;openingRef.current=true;setOpening(true);setError('');setConfirmCancel(false);
    try{const value=await api.cancelRenewal(subscription.provider);if(current===generation.current)setBilling(value);}
    catch{if(current===generation.current)setError(msg('暂时无法读取订阅，请重试。'));}
    finally{if(current===generation.current){openingRef.current=false;setOpening(false);}}
  }
  return <section className="nc-membership-card" aria-label={`NodeLane Comics ${title}`} aria-busy={opening}>
    <div className="nc-membership-heading"><span className="nc-icon-tile"><Icon name="crown" size={26}/></span><span className="nc-eyebrow">NODELANE COMICS {title}</span>{member&&<span className="nc-plan-badge">{msg('已开通')}</span>}</div>
    {managed&&subscription&&<><div className="nc-membership-price"><strong>{offerAmount(subscription.price,getLocale())}</strong><span>{subscription.price.interval==='year'?msg('每年'):msg('每月')}</span></div>
      <ul className="nc-membership-benefits">
        {rights?.modes.classic.unlimited&&<li><Icon name="check"/><span>{msg('常规翻译不设日／月累计上限')}</span></li>}
        {subscription.price.hourly_image_limit!=null&&<li><Icon name="bolt"/><span>{msg('每滚动小时最多新增 {0} 页翻译',{'0':subscription.price.hourly_image_limit.toLocaleString(getLocale())})}</span></li>}
      </ul>
      {subscription.auto_renew&&<p className="nc-membership-terms">{subscription.price.interval==='year'?msg('按年自动续费。'):msg('按月自动续费。')}</p>}
    </>}
    {member&&expiresAt&&<p>{msg('有效至 {0}',{'0':new Date(expiresAt).toLocaleDateString(getLocale())})}</p>}
    {gift&&gift.state!=='expired'&&<div className="nc-membership-gift"><strong>{msg('赠送会员 {0} 天',{'0':gift.days})}</strong>{gift.state==='pending'?<p role="status">{msg('赠送安排处理中，请刷新查看。')}</p>:<>{gift.starts_at&&<p>{msg('赠送生效：{0}',{'0':date(gift.starts_at)})}</p>}{gift.ends_at&&<p>{msg('赠送结束：{0}',{'0':date(gift.ends_at)})}</p>}</>}</div>}
    {managed&&subscription&&<div className="nc-membership-renewal">
      {subscription.paid_ends_at&&<p>{msg('已付费权益至 {0}',{'0':date(subscription.paid_ends_at)})}</p>}
      {subscription.renewal_state==='deferring'?<p role="status">{msg('续费延期处理中，请刷新查看。')}</p>:subscription.renewal_state==='resuming'?<p role="status">{msg('正在恢复续费，请刷新查看。')}</p>:subscription.renewal_state==='canceling'?<p role="status">{msg('正在取消续费，请刷新查看。')}</p>:subscription.renewal_state==='attention'?<p role="status">{msg('续费安排需要核实，请刷新或联系支持。')}</p>:subscription.auto_renew?<>{subscription.renewal_state==='deferred'&&<p>{msg('赠送期间不扣款，结束后恢复自动续费。')}</p>}{subscription.resume_at?<p>{msg('预计恢复续费：{0}',{'0':date(subscription.resume_at)})}</p>:subscription.next_billed_at&&<p>{msg('下次续费：{0}',{'0':date(subscription.next_billed_at)})}</p>}</>:<p>{msg('已关闭自动续费，已付款及赠送权益保留。')}</p>}
    </div>}
    <p>{msg('订阅和购买额度请前往定价页面。')}</p>
    <div className="nc-membership-footer">
      <a className="button primary" href={pricingUrl(getLocale())} target="_blank" rel="noopener noreferrer" onClick={()=>{returnedFromPayment.current=true;}}>{msg('前往定价页面')}<Icon name="external" size={16}/></a>
      {managed&&<button className="button secondary" disabled={opening||!billing?.enabled} onClick={()=>void openPortal()}>{opening?msg('处理中…'):msg('管理订阅')}</button>}
      {loggedIn&&<button className="button quiet small" disabled={opening||refreshing} onClick={()=>void refresh()}>{msg('刷新权益')}</button>}
      {managed&&subscription?.auto_renew&&subscription.can_cancel&&<button className="button quiet small" disabled={opening||refreshing||confirmCancel} onClick={()=>setConfirmCancel(true)}>{msg('取消自动续费')}</button>}
    </div>
    {confirmCancel&&subscription?.auto_renew&&subscription.can_cancel&&<div role="group" aria-label={msg('取消自动续费')}><p>{msg('取消后保留已付款及赠送权益，到期后不再扣款。')}</p><div className="nc-membership-footer"><button className="button secondary small" disabled={opening} onClick={()=>void cancelRenewal()}>{msg('确认取消续费')}</button><button className="button quiet small" disabled={opening} onClick={()=>setConfirmCancel(false)}>{msg('保留自动续费')}</button></div></div>}
    {(error||refreshError)&&<p className="nc-billing-error" role="alert">{error||refreshError}</p>}
  </section>;
}
