import {useEffect,useRef,useState} from 'react';
import {msg,getLocale} from '../i18n/runtime';
import type {Api} from '../api';
import type {Entitlements} from '../types';
import {type BillingStatus,stripeUrl} from '../billing';
import {Icon} from '../icons';

export function MembershipCard({api,loggedIn,rights,onLogin,onEntitlements,notify}:{api:Api;loggedIn:boolean;rights?:Entitlements;onLogin:()=>void;onEntitlements:(value:Entitlements)=>void;notify:(message:string)=>void}) {
  const [billing,setBilling]=useState<BillingStatus>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const generation=useRef(0);
  const working=useRef(false);
  const plus=loggedIn&&rights?.plan==='plus';
  const subscription=billing?.subscription;
  const managed=!!subscription&&(!['canceled','incomplete_expired'].includes(subscription.status)||[subscription.paid_ends_at,subscription.trial_ends_at].some(date=>!!date&&Date.parse(date)>Date.now()));
  const trial=billing?.trial_eligible;
  useEffect(()=>{
    const current=++generation.current;
    setBilling(undefined);setError('');setBusy(false);working.current=false;
    if(loggedIn)void api.billingStatus().then(value=>{if(current===generation.current)setBilling(value);}).catch(()=>{if(current===generation.current)setError(msg('暂时无法读取订阅，请重试。'));});
    return()=>{generation.current++;};
  },[api,loggedIn]);
  async function refresh(showNotice=true){
    if(working.current||!loggedIn)return;
    const current=generation.current;working.current=true;setBusy(true);setError('');
    try{
      const status=await api.billingStatus();
      if(current!==generation.current)return;
      setBilling(status);
      if(status.enabled){
        const result=await api.syncBilling();
        if(current!==generation.current)return;
        setBilling(result.billing);onEntitlements(result.entitlements);
      }else{
        const value=await api.entitlements();if(current===generation.current)onEntitlements(value);
      }
      if(current===generation.current&&showNotice)notify(msg('权益已刷新'));
    }catch{if(current===generation.current)setError(msg('暂时无法读取订阅，请重试。'));}
    finally{if(current===generation.current){working.current=false;setBusy(false);}}
  }
  useEffect(()=>{
    const focus=()=>{if(loggedIn&&!document.hidden)void refresh(false);};
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[api,loggedIn]);
  async function openPayment(){
    if(!loggedIn){onLogin();return;}
    if(working.current||!billing?.enabled)return;
    const current=generation.current;working.current=true;setBusy(true);setError('');
    // Reserve the tab during the click so browsers do not block the async handoff.
    const extension=typeof chrome!=='undefined'&&!!chrome.runtime?.id;
    const popup=extension?null:window.open('about:blank','_blank');
    if(popup)popup.opener=null;
    try{
      const result=managed?await api.billingPortal():await api.startCheckout();
      if(current!==generation.current){popup?.close();return;}
      const url=stripeUrl('url' in result?result.url:result.checkout_url,managed);
      if(extension)await chrome.tabs.create({url});
      else if(popup)popup.location.replace(url);
      else throw Error('popup blocked');
    }catch{popup?.close();if(current===generation.current)setError(msg('暂时无法打开 Stripe，请重试。'));}
    finally{if(current===generation.current){working.current=false;setBusy(false);}}
  }
  return <section className="nc-membership-card" aria-label="NodeLane Comics PLUS" aria-busy={busy}>
    <div className="nc-membership-heading"><span className="nc-icon-tile"><Icon name="crown" size={26}/></span><span className="nc-eyebrow">NODELANE COMICS PLUS</span>{plus&&<span className="nc-plan-badge">{msg('已开通')}</span>}</div>
    <div className="nc-membership-price"><strong>US$9.99</strong><span>{msg('每月')}</span></div>
    <ul className="nc-membership-benefits"><li><Icon name="check"/><span>{msg('常规翻译不限页数')}</span></li><li><Icon name="spark"/><span>{msg('每个付费月 300 页 AI 重绘')}</span></li><li><Icon name="bolt"/><span>{msg('每滚动 60 秒最多新增 100 张翻译图片')}</span></li></ul>
    <p className="nc-membership-terms">{(!loggedIn||trial)&&msg('首次绑卡试用 7 天，含 30 页重绘；随后自动按月续费。')}{msg('可随时取消续费，剩余重绘页数不累积。税费与最终金额以 Stripe 为准。')}</p>
    {plus&&rights?.plus_expires_at&&<p>{msg('有效至 {0}',{'0':new Date(rights.plus_expires_at).toLocaleDateString(getLocale())})}</p>}
    {billing?.subscription?.cancel_at&&<p>{msg('已取消续费，当前权益保留至到期。')}</p>}
    <div className="nc-membership-footer"><button className="button primary" disabled={busy||(loggedIn&&!billing?.enabled)} onClick={()=>void openPayment()}>{busy?msg('处理中…'):!loggedIn?msg('登录后升级'):managed?msg('在 Stripe 管理订阅'):billing?.checkout_pending?msg('继续 Stripe 结账'):trial?msg('免费试用 7 天'):msg('通过 Stripe 升级')}<Icon name="external" size={16}/></button>{loggedIn&&<button className="button quiet small" disabled={busy} onClick={()=>void refresh()}>{msg('刷新权益')}</button>}</div>
    {loggedIn&&billing&&!billing.enabled&&<p role="status">{msg('订阅暂未开放')}</p>}
    {error&&<p className="nc-billing-error" role="alert">{error}</p>}
  </section>;
}
