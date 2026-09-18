import {useEffect,useState} from 'react';
import type {Api} from '../api';
import type {BillingStatus} from '../types';
import {Modal} from './components';

export function PlusOffer({api,onChanged}:{api:Api;onChanged:()=>void}) {
  const [open,setOpen]=useState(false),[billing,setBilling]=useState<BillingStatus>();
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [statusError,setStatusError]=useState('');
  const [checkoutUrl,setCheckoutUrl]=useState(''),[cancelConfirm,setCancelConfirm]=useState(false);
  useEffect(()=>{
    let live=true;
    setBilling(undefined);setCheckoutUrl('');setOpen(false);setCancelConfirm(false);
    setBusy('');setError('');setStatusError('');setMessage('');
    const load=()=>void api.billingStatus().then(value=>{if(live&&api.isCurrent()){setBilling(value);setStatusError('');onChanged();}}).catch(()=>{if(live)setStatusError('暂时无法读取支付状态，请稍后刷新。');});
    load();const timer=setInterval(load,5000);
    window.addEventListener('focus',load);
    return()=>{live=false;clearInterval(timer);window.removeEventListener('focus',load);};
  },[api,onChanged]);
  async function launch(kind:'checkout'|'portal') {
    setBusy(kind);setError('');setMessage('');
    const popup=window.open('about:blank','_blank');if(popup)popup.opener=null;
    try {
      const result=kind==='checkout'?await api.billingCheckout():await api.billingPortal();
      if(!api.isCurrent()){popup?.close();return;}
      const url='checkout_url' in result?result.checkout_url:result.url;
      if(new URL(url).protocol!=='https:')throw new Error('支付链接无效，请联系管理员');
      setCheckoutUrl(url);if(popup)popup.location.href=url;
      setMessage('已打开安全支付页面，完成后返回这里刷新权益。');
    }catch(e){popup?.close();if(api.isCurrent())setError((e as Error).message);}finally{if(api.isCurrent())setBusy('');}
  }
  async function refresh() {
    setBusy('sync');setError('');
    try {const result=await api.billingSync();if(api.isCurrent()){setBilling(result.billing);onChanged();setMessage('已同步最新订阅与权益。');}}
    catch(e){if(api.isCurrent())setError((e as Error).message);}finally{if(api.isCurrent())setBusy('');}
  }
  async function cancel() {
    setBusy('cancel');setError('');
    try {const result=await api.billingCancel();if(api.isCurrent()){setBilling(result);onChanged();setCancelConfirm(false);setMessage('已取消自动续费，当前权益保留至有效期结束。');}}
    catch(e){if(api.isCurrent())setError((e as Error).message);}finally{if(api.isCurrent())setBusy('');}
  }
  const sub=billing?.subscription;
  const active=!!sub&&(['active','trialing','past_due','paused'].includes(sub.status)||!!billing?.entitlement_expires_at&&Date.parse(billing.entitlement_expires_at)>Date.now());
  const labels:Record<string,string>={trialing:'免费试用中',active:'已订阅 PLUS',past_due:'付款失败，请更新付款方式',canceled:'已取消订阅',paused:'订阅已暂停'};
  return <section className="settings-card" aria-label="PLUS 套餐与免费试用">
    <div className="nc-section-heading"><div><h2>PLUS · US$9.99 / 月</h2><p className="nc-muted">绑定信用卡，免费试用 7 天。试用支持同时翻译 10 张，含 30 页 AI 重绘。</p></div>
      <button className="button secondary" onClick={() => setOpen(true)}>了解 PLUS 与免费试用</button></div>
    <p className="nc-muted">试用结束后每月自动续费，可取消。{billing?(billing.enabled?'':'订阅与试用尚未开放。'):'正在读取订阅状态…'}</p>
    {billing?.enabled&&<>
      {billing.environment==='sandbox'&&<p className="nc-muted">沙盒测试：仅使用 Paddle 测试银行卡，不产生真实付款。</p>}
      {sub&&<p>{sub.cancel_at?'已取消自动续费':labels[sub.status]??'正在确认订阅'}{sub.next_billed_at&&!sub.cancel_at&&` · 下次扣款 ${new Date(sub.next_billed_at).toLocaleString()}`}</p>}
      {billing.entitlement_expires_at&&<p className="nc-muted">订阅权益有效至 {new Date(billing.entitlement_expires_at).toLocaleString()}</p>}
      {billing.checkout_pending&&<p role="status">{billing.checkout_error?'原结账结果正在核实，请刷新状态后继续原结账。':'结账尚未完成，再次打开将恢复原交易。'}</p>}
      {!active&&<button className="button primary" disabled={!!busy} onClick={()=>setOpen(true)}>{billing.checkout_pending?'继续原结账':billing.trial_eligible?'开始 7 天免费试用':'订阅 PLUS'}</button>}
      {sub&&<button className="button secondary" disabled={!!busy} onClick={()=>void launch('portal')}>管理付款方式与订阅</button>}
      <button className="button secondary" disabled={!!busy} onClick={()=>void refresh()}>{busy==='sync'?'正在同步…':'刷新订阅与权益'}</button>
      {active&&!sub?.cancel_at&&sub&&['active','trialing','past_due'].includes(sub.status)&&<button className="button quiet" disabled={!!busy} onClick={()=>setCancelConfirm(true)}>取消自动续费</button>}
      {cancelConfirm&&<div><p>确认取消自动续费？本次试用或已付款权益保留至有效期结束。</p><button className="button secondary" disabled={!!busy} onClick={()=>void cancel()}>{busy==='cancel'?'正在取消…':'确认取消续费'}</button><button className="button quiet" disabled={!!busy} onClick={()=>setCancelConfirm(false)}>保留续费</button></div>}
    </>}
    {busy&&<p role="status">{busy==='checkout'?'正在准备结账…':busy==='portal'?'正在打开订阅管理…':''}</p>}
    {statusError&&<p role="alert">{statusError}</p>}{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {checkoutUrl&&<a href={checkoutUrl} target="_blank" rel="noopener noreferrer">重新打开支付页面</a>}
    {open && <Modal title="PLUS 与 7 天免费试用" subtitle="唯一套餐 · US$9.99 / 月" onClose={() => setOpen(false)}>
      <p className="modal-copy">通过 Paddle 绑定信用卡后开始 7 天免费试用。每个账户限一次；试用期间支持同时翻译 10 张，含 30 页 AI 重绘，剩余试用页数到期失效。</p>
      <p className="modal-copy">试用结束后自动扣款 US$9.99，之后每月续费。正式 PLUS 每个付费周期含 300 页 AI 重绘，支持同时翻译 10 张；重绘剩余页数不累积。</p>
      <p className="modal-copy">可在试用结束前取消以避免首次扣款，也可取消后续续费。具体扣款时间、税费与最终金额会在 Paddle 结账页展示。</p>
      {billing?.enabled&&!active?<><p className="nc-muted">{billing.trial_eligible?'点击下方按钮后，将前往 Paddle 绑定银行卡并确认自动续费。':'此账户已领取过试用，本次订阅将立即付款。'}</p><button className="button primary" disabled={!!busy} onClick={()=>void launch('checkout')}>{busy==='checkout'?'正在准备结账…':billing.checkout_pending?'继续原结账':billing.trial_eligible?'前往绑定银行卡并试用':'前往订阅 PLUS'}</button>{error&&<p role="alert">{error}</p>}{checkoutUrl&&<p><a href={checkoutUrl} target="_blank" rel="noopener noreferrer">打开支付页面</a></p>}</>:<p className="nc-muted" role="status">{active?'你已有订阅，可在账户页管理续费。':'订阅与试用尚未开放，当前可以查看套餐说明。'}</p>}
    </Modal>}
  </section>;
}
