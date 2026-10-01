import { useEffect, useRef, useState } from 'react';
import { api, ApiError, finishLogin, session, signIn, signOut, loginReturnPath } from '../lib/auth';
import { checkoutUrl } from '../lib/auth-config';
import {billingCopy,billingBenefitCopy,offerLabel,offerBenefits,renewalCopy,trialCopy,providerLabel,manageLabel,selectedChannel,hasManagedSubscription,subscriptionStatusLabel,type Billing,type BillingProvider,type MembershipGift} from '../lib/billing';
import BillingCycle,{selectedInterval,type BillingInterval} from './BillingCycle';
interface Entitlements {plan:string;plus_expires_at:string|null;gift?:MembershipGift|null;hourly_image_rate_limit?:{window_seconds:number;limit:number}|null}
interface Me { user: { id: string; name: string }; entitlements: Entitlements }
const date = (value: string | null, locale: string) => value ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(value)) : '—';
const message = (error: unknown) => error instanceof ApiError ? error.message : error instanceof TypeError ? '网络连接失败，请检查连接后重试。' : error instanceof Error && !/state|token|grant|fetch|timeout/i.test(error.message) ? error.message : '操作暂未完成，请重试或重新登录。';

export default function Account({ callback = false, locale = 'zh-CN', copy = {}, accountHref = '/account/' }: { callback?: boolean; locale?: string; copy?: Record<string,string>; accountHref?: string }) {
  const t=(value:string)=>copy[value] ?? (locale==='zh-CN' ? value : /[\u3400-\u9fff]/.test(value) ? copy['操作暂未完成，请重试或重新登录。'] || value : value);
  const local=(path:string)=>accountHref.replace(/account\/$/, '') + path.replace(/^\//,'');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [me, setMe] = useState<Me | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [consent, setConsent] = useState(false);
  const [confirmCancel,setConfirmCancel]=useState(false);
  const gift=billing?billing.gift:me?.entitlements.gift;
  const subscription=billing?.subscription;
  const [selectedPrice,setSelectedPrice]=useState(()=>typeof window==='undefined'?'':new URLSearchParams(window.location.search).get('price')??'');
  const [showPlans,setShowPlans]=useState(()=>typeof window!=='undefined'&&new URLSearchParams(window.location.search).has('price'));
  useEffect(()=>{if(billing?.checkout_pending)setShowPlans(true);},[billing?.checkout_pending]);
  const [preferredCycle,setPreferredCycle]=useState<BillingInterval>('month');
  const available=(billing?.offers??[]).filter(p=>p.plan_id==='lite');
  const cycle=selectedInterval(available,available.find(p=>p.id===selectedPrice)?.interval??preferredCycle);
  const visibleOffers=available.filter(p=>p.interval===cycle);
  const offer=billing?.checkout_price??visibleOffers.find(p=>p.id===selectedPrice)??visibleOffers[0];
  const channel=selectedChannel(offer,'',billing?.checkout_provider);
  const billingText=billingCopy(locale),benefitText=billingBenefitCopy(locale);
  const epoch = useRef(0);
  const initialized = useRef(false);
  async function load() {
    const current = ++epoch.current;
    setLoading(true); setError('');
    try {
      if (!await session()) { if (current === epoch.current) { setMe(null); setBilling(null); } return; }
      const account = await api<Me>('/v1/me');
      if (current !== epoch.current) return;
      setMe(account);
      const status = await api<Billing>('/v1/billing/status');
      if (current === epoch.current) {setBilling(status);}
      if(status.enabled){
        const refreshed=await api<{billing:Billing;entitlements:Entitlements}>('/v1/billing/sync','POST');
        if(current===epoch.current){setBilling(refreshed.billing);setMe({...account,entitlements:refreshed.entitlements});}
      }
    } catch (err) {
      if (current !== epoch.current) return;
      if (err instanceof ApiError && err.status === 401) { setMe(null); setBilling(null); }
      setError(t(message(err)));
    } finally { if (current === epoch.current) setLoading(false); }
  }
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (callback) void finishLogin().then(() => location.replace(loginReturnPath())).catch(err => { setError(t(message(err))); setLoading(false); });
    else void load();
  }, [callback]);

  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (err) {
      if (err instanceof ApiError && err.status === 401) { setMe(null); setBilling(null); }
      setError(t(message(err)));
    } finally { setBusy(false); }
  }
  if (callback) return <div className="status-panel" role="status">{loading ? t("正在确认登录结果，请稍候…") : <><p>{error}</p><a className="text-link" href={local('/account/')}>{t("返回账户重新登录 ↗")}</a></>}</div>;
  return <div className="website-account" aria-busy={loading || busy}>
    {error && <div className="status-panel error" role="alert">{error} <button className="button compact secondary" disabled={busy || loading} onClick={() => void load()}>{t("重试连接")}</button></div>}
    {loading ? <div className="loading" role="status">{t("正在读取你的账户…")}</div> : !me ? <div className="login-passport"><div className="login-cover"><p className="eyebrow">NODELANE COMICS / READER PASS</p><h2>{t("下一页，")}<br />{t("读懂新世界。")}</h2><div className="login-ticket">{t("あ → 你好")}</div><p>{t("一个账户，连接官网与插件。")}<br />{t("你的翻译权益，都在这里。")}</p></div><div className="login-form"><p className="eyebrow">WELCOME BACK</p><h2>{t("打开你的读者通行证")}</h2><p>{t("前往统一身份服务安全登录，完成后自动回到这里。")}</p><button className="button" disabled={busy} onClick={() => void action(() => signIn(accountHref+location.search))}>{busy ? t("正在前往登录…") : t("登录 / 注册")} <span aria-hidden="true">↗</span></button><small>{t("继续前请阅读")}<a className="text-link" href={local('/terms/')}>{t("服务条款")}</a>{t("与")}<a className="text-link" href={local('/privacy/')}>{t("隐私政策")}</a>{t("。官网不会收集你的登录密码。")}</small></div></div> : <>
      <section className="account-summary" aria-label={t("账户信息")}>
        <div className="account-identity"><span className="account-avatar" aria-hidden="true">{me.user.name.slice(0,1).toUpperCase()}</span><div><h2>{me.user.name}</h2><span className="account-plan" data-plus={me.entitlements.plan!=='free'}>{me.entitlements.plan==='plus'?'PLUS':me.entitlements.plan==='lite'?'Lite':t("普通账户")}</span></div><button className="account-signout" disabled={busy} onClick={() => void action(async () => { epoch.current++; setMe(null); setBilling(null); await signOut(); })}>{t("退出登录")}</button></div>
        {me.entitlements.plan!=='free'&&me.entitlements.plus_expires_at&&<p className="account-expiry">{t("会员有效期至")}{date(me.entitlements.plus_expires_at,locale)}{t("（北京时间）")}</p>}
        {me.entitlements.hourly_image_rate_limit&&<p className="account-rate-limit">{benefitText.hourly(me.entitlements.hourly_image_rate_limit.limit)}</p>}
        {gift&&gift.state!=='expired'&&<div className="account-gift"><strong>{t('赠送 PLUS {0} 天').replace('{0}',String(gift.days))}</strong>{gift.state==='pending'?<p role="status">{t('赠送安排处理中，请刷新查看。')}</p>:<>{gift.starts_at&&<p>{t('赠送生效：{0}').replace('{0}',date(gift.starts_at,locale))}{t('（北京时间）')}</p>}{gift.ends_at&&<p>{t('赠送结束：{0}').replace('{0}',date(gift.ends_at,locale))}{t('（北京时间）')}</p>}</>}</div>}
        <div className="account-reading-note"><p>{t("阅读、翻译和用量查看，请前往浏览器插件。")}</p><a className="text-link" href={local('/download/')}>{t("下载插件")} ↗</a></div>
      </section>
      <section className="account-subscription"><div className="account-section-heading"><h3>{t("会员订阅")}</h3><button className="account-refresh" disabled={busy || loading} onClick={()=>void load()}>{t("刷新")}</button></div>{!billing ? <p>{t("暂时无法读取订阅状态，请刷新重试。")}</p> : !billing.enabled ? <p>{t("订阅服务当前不可用。已有权益不受此提示影响，如需帮助请联系 comics@nodelane.net。")}</p> : billing.subscription && hasManagedSubscription(billing.subscription.status,billing.entitlement_expires_at) ? <>
        <p className="subscription-price">{offerLabel(billing.subscription.price,locale)}</p>
        <p>{offerBenefits(billing.subscription.price,locale)}</p>
        <dl className="subscription-facts"><div><dt>{t("订阅状态")}</dt><dd>{subscriptionStatusLabel(billing.subscription.status,locale)}</dd></div></dl>
        {subscription?.paid_ends_at&&<p>{t('已付费权益至 {0}').replace('{0}',date(subscription.paid_ends_at,locale))}{t('（北京时间）')}</p>}
        {subscription?.renewal_state==='deferring'?<p role="status">{t('续费延期处理中，请刷新查看。')}</p>:subscription?.renewal_state==='resuming'?<p role="status">{t('正在恢复续费，请刷新查看。')}</p>:subscription?.renewal_state==='canceling'?<p role="status">{t('正在取消续费，请刷新查看。')}</p>:subscription?.renewal_state==='attention'?<p role="status">{t('续费安排需要核实，请刷新或联系支持。')}</p>:subscription?.auto_renew?<>{subscription.renewal_state==='deferred'&&<p>{t('赠送期间不扣款，结束后恢复自动续费。')}</p>}{subscription.resume_at?<p>{t('预计恢复续费：{0}').replace('{0}',date(subscription.resume_at,locale))}{t('（北京时间）')}</p>:subscription.next_billed_at&&<p>{t('下次续费：{0}').replace('{0}',date(subscription.next_billed_at,locale))}{t('（北京时间）')}</p>}</>:<p>{t('已关闭自动续费，已付款及赠送权益保留。')}</p>}
        <button className="button compact secondary" disabled={busy} onClick={() => void action(async () => { const provider=billing.subscription!.provider;const result=await api<{url:string;provider:BillingProvider}>('/v1/billing/portal','POST',{provider});if(result.provider!==provider)throw Error('结账地址无效，请联系支持。');location.assign(checkoutUrl(result.url,provider,true)); })}>{manageLabel(locale)} · {providerLabel(billing.subscription.provider)} ↗</button>
        {subscription?.auto_renew&&subscription.can_cancel&&<button className="button compact secondary" disabled={busy||confirmCancel} onClick={()=>setConfirmCancel(true)}>{t('取消自动续费')}</button>}
        {confirmCancel&&subscription?.auto_renew&&subscription.can_cancel&&<div role="group" aria-label={t('取消自动续费')}><p>{t('取消后保留已付款及赠送权益，到期后不再扣款。')}</p><button className="button compact secondary" disabled={busy} onClick={()=>void action(async()=>{setConfirmCancel(false);const value=await api<Billing>('/v1/billing/cancel-renewal','POST',{provider:subscription.provider});setBilling(value);})}>{t('确认取消续费')}</button><button className="button compact secondary" disabled={busy} onClick={()=>setConfirmCancel(false)}>{t('保留自动续费')}</button></div>}
      </> : gift&&gift.state!=='expired' ? <p>{t("赠送结束后可开通订阅。")}</p> : <><p>{benefitText.intro}</p><details className="account-upgrade" open={showPlans} onToggle={event=>setShowPlans(event.currentTarget.open)}><summary>{billing.checkout_pending?t("继续原结账"):t("选择订阅套餐")}</summary>{!billing.checkout_pending&&available.length>0&&<><BillingCycle offers={available} value={cycle} locale={locale} disabled={busy} onChange={value=>{setPreferredCycle(value);setSelectedPrice('');setConsent(false);}}/><div className="billing-plan-picker" role="group" aria-label={billingText.plan}>{visibleOffers.map(p=><button type="button" className="billing-plan-card" key={p.id} aria-pressed={offer?.id===p.id} disabled={busy} onClick={()=>{setSelectedPrice(p.id);setConsent(false);}}><strong>{offerLabel(p,locale)}</strong><span>{offerBenefits(p,locale)}</span></button>)}</div></>}{offer?<><p>{offerLabel(offer,locale)}</p><p>{offerBenefits(offer,locale)}</p><p>{billing.trial_eligible&&channel&&channel.trial_days>0&&trialCopy(channel.trial_days,channel.trial_redraw_pages,locale)} {renewalCopy(offer,locale)}{t("可在下次续费前取消，税费及应付金额以结账页为准。")}</p></>:<p>{billingText.unavailable}</p>}<label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} /><span>{t("我已阅读")}<a className="text-link" href={local('/refund/')}>{t("订阅与退款说明")}</a>{t("，了解自动续费规则。")}</span></label><button className="button" disabled={busy || !consent || !offer || !channel} onClick={() => void action(async () => { const provider=channel!.provider;const result = await api<{checkout_url:string;provider:BillingProvider}>('/v1/billing/checkouts','POST',{price_id:offer!.id,provider});if(result.provider!==provider)throw Error('结账地址无效，请联系支持。');location.assign(checkoutUrl(result.checkout_url,provider)); })}>{billing.checkout_pending ? t("继续原结账") : t("前往安全结账")} ↗</button></details></>}
      </section><p className="account-session-note">{t("退出仅清除官网当前标签页的账户会话，不会取消订阅，也不会退出插件或身份服务中的其他应用。")}</p>
    </>}
  </div>;
}
