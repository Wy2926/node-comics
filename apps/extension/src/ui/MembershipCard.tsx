import {useEffect,useRef,useState} from 'react';
import {msg,getLocale} from '../i18n/runtime';
import type {Api} from '../api';
import type {Entitlements} from '../types';
import {type BillingStatus,type BillingCatalog,paymentUrl,selectedChannel,hasManagedSubscription,offerAmount} from '../billing';
import {Icon} from '../icons';

export function MembershipCard({api,loggedIn,rights,onLogin,onEntitlements,notify}:{api:Api;loggedIn:boolean;rights?:Entitlements;onLogin:()=>void;onEntitlements:(value:Entitlements)=>void;notify:(message:string)=>void}) {
  const [billing,setBilling]=useState<BillingStatus>();
  const [catalog,setCatalog]=useState<BillingCatalog>();
  const [preferredCycle,setPreferredCycle]=useState<'month'|'year'>('month');
  const [opening,setOpening]=useState(false);
  const [refreshing,setRefreshing]=useState(false);
  const [error,setError]=useState('');
  const [refreshError,setRefreshError]=useState('');
  const generation=useRef(0);
  const openingRef=useRef(false);
  const refreshingRef=useRef(false);
  const lastAutomaticRead=useRef(0);
  const returnedFromPayment=useRef(false);
  const plus=loggedIn&&rights?.plan==='plus';
  const subscription=billing?.subscription;
  const managed=!!subscription&&hasManagedSubscription(subscription.status,billing?.entitlement_expires_at);
  const available=(loggedIn?billing:catalog)?.offers??[];
  const cycle=available.some(p=>p.interval===preferredCycle)?preferredCycle:available[0]?.interval??preferredCycle;
  const purchaseOffer=billing?.checkout_price??available.find(p=>p.interval===cycle);
  const offer=managed?subscription.price:purchaseOffer;
  const channel=selectedChannel(purchaseOffer,'',billing?.checkout_provider);
  const provider=managed?subscription.provider:channel?.provider;
  const trial=(!loggedIn||billing?.trial_eligible)&&!!channel?.trial_days;
  useEffect(()=>{
    const current=++generation.current;
    setBilling(undefined);setCatalog(undefined);setError('');setRefreshError('');setOpening(false);setRefreshing(false);
    openingRef.current=false;refreshingRef.current=false;returnedFromPayment.current=false;
    lastAutomaticRead.current=Date.now();
    if(loggedIn)void api.billingStatus().then(value=>{if(current===generation.current)setBilling(value);}).catch(()=>{if(current===generation.current)setRefreshError(msg('暂时无法读取订阅，请重试。'));});
    else void api.billingCatalog().then(value=>{if(current===generation.current)setCatalog(value);}).catch(()=>{if(current===generation.current)setRefreshError(msg('暂时无法读取订阅，请重试。'));});
    return()=>{generation.current++;};
  },[api,loggedIn]);
  async function refresh(manual=true){
    if(refreshingRef.current||openingRef.current)return;
    const reconcile=manual||returnedFromPayment.current;
    if(!manual&&!reconcile&&Date.now()-lastAutomaticRead.current<30000)return;
    const current=generation.current;
    refreshingRef.current=true;lastAutomaticRead.current=Date.now();returnedFromPayment.current=false;
    setRefreshing(true);setRefreshError('');
    try{
      if(!loggedIn){const value=await api.billingCatalog();if(current===generation.current)setCatalog(value);return;}
      const status=await api.billingStatus();
      if(current!==generation.current)return;
      setBilling(status);
      if(status.enabled&&reconcile){
        const result=await api.syncBilling();
        if(current!==generation.current)return;
        setBilling(result.billing);onEntitlements(result.entitlements);
      }else if(manual){
        const value=await api.entitlements();if(current===generation.current)onEntitlements(value);
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
  async function openPayment(){
    if(!loggedIn){onLogin();return;}
    // Background membership reads never consume the user's click or disable this action.
    if(openingRef.current||!billing?.enabled||!provider||(!managed&&(!offer||!provider)))return;
    const current=generation.current;openingRef.current=true;setOpening(true);setError('');
    const extension=typeof chrome!=='undefined'&&!!chrome.runtime?.id;
    let popup:Window|null=null;
    try{
      // Reserve the tab during the click so browsers do not block the async handoff.
      if(!extension){popup=window.open('about:blank','_blank');if(!popup)throw Error('popup blocked');popup.opener=null;}
      const result=managed?await api.billingPortal(provider):await api.startCheckout(offer!.id,provider);
      if(current!==generation.current){popup?.close();return;}
      if(result.provider!==provider)throw Error('provider mismatch');
      const url=paymentUrl('url' in result?result.url:result.checkout_url,provider,managed);
      if(extension)await chrome.tabs.create({url});
      else popup!.location.replace(url);
      returnedFromPayment.current=true;
    }catch{popup?.close();if(current===generation.current)setError(msg('暂时无法打开支付页面，请重试。'));}
    finally{if(current===generation.current){openingRef.current=false;setOpening(false);}}
  }
  return <section className="nc-membership-card" aria-label="NodeLane Comics PLUS" aria-busy={opening}>
    <div className="nc-membership-heading"><span className="nc-icon-tile"><Icon name="crown" size={26}/></span><span className="nc-eyebrow">NODELANE COMICS PLUS</span>{plus&&<span className="nc-plan-badge">{msg('已开通')}</span>}
      {!managed&&!billing?.checkout_pending&&available.length>0&&<div className="nc-billing-cycle" role="group" aria-label={msg('订阅套餐')}>{(['month','year'] as const).map(value=><button type="button" key={value} aria-pressed={cycle===value} disabled={opening||!available.some(p=>p.interval===value)} onClick={()=>setPreferredCycle(value)}>{value==='year'?msg('每年'):msg('每月')}</button>)}</div>}
    </div>
    {offer&&<><div className="nc-membership-price"><strong>{offerAmount(offer,getLocale())}</strong><span>{offer.interval==='year'?msg('每年'):msg('每月')}</span></div>
    <ul className="nc-membership-benefits"><li><Icon name="check"/><span>{msg('常规翻译不限页数')}</span></li><li><Icon name="spark"/><span>{msg('每月 {0} 页 AI 重绘',{'0':offer.monthly_redraw_pages})}</span></li><li><Icon name="bolt"/><span>{msg('每滚动 60 秒最多新增 100 张翻译图片')}</span></li></ul>
    <p className="nc-membership-terms">{trial&&msg('首次试用 {0} 天，含 {1} 页重绘。',{'0':channel!.trial_days,'1':channel!.trial_redraw_pages})}{offer.interval==='year'?msg('按年自动续费，重绘额度逐月生效。'):msg('按月自动续费。')}{msg('可随时取消续费，剩余重绘页数不累积。税费与最终金额以结账页为准。')}</p></>}
    {plus&&rights?.plus_expires_at&&<p>{msg('有效至 {0}',{'0':new Date(rights.plus_expires_at).toLocaleDateString(getLocale())})}</p>}
    {billing?.subscription?.cancel_at&&<p>{msg('已取消续费，当前权益保留至到期。')}</p>}
    <div className="nc-membership-footer"><button className="button primary" disabled={opening||(loggedIn&&(!billing?.enabled||(!managed&&(!offer||!provider))))} onClick={()=>void openPayment()}>{opening?msg('处理中…'):!loggedIn?msg('登录后升级'):managed?msg('管理订阅'):billing?.checkout_pending?msg('继续原结账'):msg('前往安全结账')}<Icon name="external" size={16}/></button>{(loggedIn||refreshError)&&<button className="button quiet small" disabled={opening||refreshing} onClick={()=>void refresh()}>{loggedIn?msg('刷新权益'):msg('重试')}</button>}</div>
    {loggedIn&&billing&&(!billing.enabled||(!managed&&(!offer||!provider)))&&<p role="status">{msg('订阅暂未开放')}</p>}
    {(error||refreshError)&&<p className="nc-billing-error" role="alert">{error||refreshError}</p>}
  </section>;
}
