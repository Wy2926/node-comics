import {useEffect,useRef,useState} from 'react';
import {msg,getLocale} from '../i18n/runtime';
import type {Api} from '../api';
import type {Entitlements} from '../types';
import {type BillingStatus,stripeUrl,offerAmount} from '../billing';
import {Icon} from '../icons';

export function MembershipCard({api,loggedIn,rights,onLogin,onEntitlements,notify}:{api:Api;loggedIn:boolean;rights?:Entitlements;onLogin:()=>void;onEntitlements:(value:Entitlements)=>void;notify:(message:string)=>void}) {
  const [billing,setBilling]=useState<BillingStatus>();
  const [selectedPrice,setSelectedPrice]=useState('');
  const [preferredCycle,setPreferredCycle]=useState<'month'|'year'>('month');
  const [opening,setOpening]=useState(false);
  const [refreshing,setRefreshing]=useState(false);
  const [error,setError]=useState('');
  const [refreshError,setRefreshError]=useState('');
  const generation=useRef(0);
  const openingRef=useRef(false);
  const refreshingRef=useRef(false);
  const lastAutomaticRead=useRef(0);
  const returnedFromStripe=useRef(false);
  const plus=loggedIn&&rights?.plan==='plus';
  const subscription=billing?.subscription;
  const managed=!!subscription&&(!['canceled','incomplete_expired'].includes(subscription.status)||[subscription.paid_ends_at,subscription.trial_ends_at].some(date=>!!date&&Date.parse(date)>Date.now()));
  const available=billing?.offers??[];
  const preferred=available.find(p=>p.id===selectedPrice)?.interval??preferredCycle;
  const cycle=available.some(p=>p.interval===preferred)?preferred:available[0]?.interval??preferred;
  const visibleOffers=available.filter(p=>p.interval===cycle);
  const offer=(managed?subscription.price:billing?.checkout_price)??visibleOffers.find(p=>p.id===selectedPrice)??visibleOffers[0];
  const trial=billing?.trial_eligible&&!!offer?.trial_days;
  useEffect(()=>{
    const current=++generation.current;
    setBilling(undefined);setError('');setRefreshError('');setOpening(false);setRefreshing(false);
    openingRef.current=false;refreshingRef.current=false;returnedFromStripe.current=false;
    lastAutomaticRead.current=Date.now();
    if(loggedIn)void api.billingStatus().then(value=>{if(current===generation.current)setBilling(value);}).catch(()=>{if(current===generation.current)setRefreshError(msg('暂时无法读取订阅，请重试。'));});
    return()=>{generation.current++;};
  },[api,loggedIn]);
  async function refresh(manual=true){
    if(refreshingRef.current||openingRef.current||!loggedIn)return;
    const reconcile=manual||returnedFromStripe.current;
    if(!manual&&!reconcile&&Date.now()-lastAutomaticRead.current<30000)return;
    const current=generation.current;
    refreshingRef.current=true;lastAutomaticRead.current=Date.now();returnedFromStripe.current=false;
    setRefreshing(true);setRefreshError('');
    try{
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
    if(openingRef.current||!billing?.enabled||(!managed&&!offer))return;
    const current=generation.current;openingRef.current=true;setOpening(true);setError('');
    const extension=typeof chrome!=='undefined'&&!!chrome.runtime?.id;
    let popup:Window|null=null;
    try{
      // Reserve the tab during the click so browsers do not block the async handoff.
      if(!extension){popup=window.open('about:blank','_blank');if(!popup)throw Error('popup blocked');popup.opener=null;}
      const result=managed?await api.billingPortal():await api.startCheckout(offer!.id);
      if(current!==generation.current){popup?.close();return;}
      const url=stripeUrl('url' in result?result.url:result.checkout_url,managed);
      if(extension)await chrome.tabs.create({url});
      else popup!.location.replace(url);
      returnedFromStripe.current=true;
    }catch{popup?.close();if(current===generation.current)setError(msg('暂时无法打开 Stripe，请重试。'));}
    finally{if(current===generation.current){openingRef.current=false;setOpening(false);}}
  }
  return <section className="nc-membership-card" aria-label="NodeLane Comics PLUS" aria-busy={opening}>
    <div className="nc-membership-heading"><span className="nc-icon-tile"><Icon name="crown" size={26}/></span><span className="nc-eyebrow">NODELANE COMICS PLUS</span>{plus&&<span className="nc-plan-badge">{msg('已开通')}</span>}</div>
    {!managed&&!billing?.checkout_pending&&available.length>0&&<><div className="nc-billing-cycle" role="group" aria-label={msg('订阅套餐')}>{(['month','year'] as const).map(value=><button type="button" key={value} aria-pressed={cycle===value} disabled={opening||!available.some(p=>p.interval===value)} onClick={()=>{setPreferredCycle(value);setSelectedPrice('');}}>{value==='year'?msg('每年'):msg('每月')}</button>)}</div><div className="nc-billing-plans">{visibleOffers.map(p=><button type="button" key={p.id} aria-pressed={offer?.id===p.id} disabled={opening} onClick={()=>setSelectedPrice(p.id)}><strong>{p.name}</strong><span>{offerAmount(p,getLocale())} / {p.interval==='year'?msg('每年'):msg('每月')}</span></button>)}</div></>}
    {offer&&<><div className="nc-membership-price"><strong>{offerAmount(offer,getLocale())}</strong><span>{offer.interval==='year'?msg('每年'):msg('每月')}</span></div>
    <ul className="nc-membership-benefits"><li><Icon name="check"/><span>{msg('常规翻译不限页数')}</span></li><li><Icon name="spark"/><span>{msg('每月 {0} 页 AI 重绘',{'0':offer.monthly_redraw_pages})}</span></li></ul>
    <p className="nc-membership-terms">{trial&&msg('首次试用 {0} 天，含 {1} 页重绘。',{'0':offer.trial_days,'1':offer.trial_redraw_pages})}{offer.interval==='year'?msg('按年自动续费，重绘额度逐月生效。'):msg('按月自动续费。')}{msg('可随时取消续费，剩余重绘页数不累积。税费与最终金额以 Stripe 为准。')}</p></>}
    {plus&&rights?.plus_expires_at&&<p>{msg('有效至 {0}',{'0':new Date(rights.plus_expires_at).toLocaleDateString(getLocale())})}</p>}
    {billing?.subscription?.cancel_at&&<p>{msg('已取消续费，当前权益保留至到期。')}</p>}
    <div className="nc-membership-footer"><button className="button primary" disabled={opening||(loggedIn&&(!billing?.enabled||(!managed&&!offer)))} onClick={()=>void openPayment()}>{opening?msg('处理中…'):!loggedIn?msg('登录后升级'):managed?msg('在 Stripe 管理订阅'):billing?.checkout_pending?msg('继续 Stripe 结账'):msg('通过 Stripe 升级')}<Icon name="external" size={16}/></button>{loggedIn&&<button className="button quiet small" disabled={opening||refreshing} onClick={()=>void refresh()}>{msg('刷新权益')}</button>}</div>
    {loggedIn&&billing&&(!billing.enabled||(!managed&&!offer))&&<p role="status">{msg('订阅暂未开放')}</p>}
    {(error||refreshError)&&<p className="nc-billing-error" role="alert">{error||refreshError}</p>}
  </section>;
}
