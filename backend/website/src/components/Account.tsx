import { useEffect, useRef, useState } from 'react';
import { api, ApiError, finishLogin, session, signIn, signOut, loginReturnPath } from '../lib/auth';
import { checkoutUrl } from '../lib/auth-config';
import {billingCopy,offerLabel,providerLabel,channelLabel,manageLabel,selectedChannel,hasManagedSubscription,subscriptionStatusLabel,type Billing,type BillingProvider} from '../lib/billing';
import BillingCycle,{selectedInterval,type BillingInterval} from './BillingCycle';
interface Entitlements { plan: string; plus_expires_at: string | null; image_rate_limit: { limit: number }; modes: Record<string, { unlimited: boolean; allowed: boolean; quota: { available: number; granted: number; reserved: number } | null }> }
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
  const [selectedPrice,setSelectedPrice]=useState(()=>typeof window==='undefined'?'':new URLSearchParams(window.location.search).get('price')??'');
  const [preferredCycle,setPreferredCycle]=useState<BillingInterval>('month');
  const available=billing?.offers??[];
  const cycle=selectedInterval(available,available.find(p=>p.id===selectedPrice)?.interval??preferredCycle);
  const visibleOffers=available.filter(p=>p.interval===cycle);
  const offer=billing?.checkout_price??visibleOffers.find(p=>p.id===selectedPrice)??visibleOffers[0];
  const channel=selectedChannel(offer,'',billing?.checkout_provider);
  const billingText=billingCopy(locale);
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
      if (current === epoch.current) setBilling(status);
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
  return <div aria-busy={loading || busy}>
    {error && <div className="status-panel error" role="alert">{error} <button className="button compact secondary" disabled={busy || loading} onClick={() => void load()}>{t("重试连接")}</button></div>}
    {loading ? <div className="loading" role="status">{t("正在读取你的账户…")}</div> : !me ? <div className="login-passport"><div className="login-cover"><p className="eyebrow">NODELANE COMICS / READER PASS</p><h2>{t("下一页，")}<br />{t("读懂新世界。")}</h2><div className="login-ticket">{t("あ → 你好")}</div><p>{t("一个账户，连接官网与插件。")}<br />{t("你的翻译权益，都在这里。")}</p></div><div className="login-form"><p className="eyebrow">WELCOME BACK</p><h2>{t("打开你的读者通行证")}</h2><p>{t("前往统一身份服务安全登录，完成后自动回到这里。")}</p><button className="button" disabled={busy} onClick={() => void action(() => signIn(accountHref+location.search))}>{busy ? t("正在前往登录…") : t("登录 / 注册")} <span aria-hidden="true">↗</span></button><small>{t("继续前请阅读")}<a className="text-link" href={local('/terms/')}>{t("服务条款")}</a>{t("与")}<a className="text-link" href={local('/privacy/')}>{t("隐私政策")}</a>{t("。官网不会收集你的登录密码。")}</small></div></div> : <>
      <div className="account-heading"><div><p className="eyebrow">YOUR READER PASS</p><h2 style={{ marginTop: 12 }}>{t("你好，")}{me.user.name}</h2></div><button className="button compact secondary" disabled={busy} onClick={() => void action(async () => { epoch.current++; setMe(null); setBilling(null); await signOut(); })}>{t("退出官网账户")}</button></div>
      <div className="account-stats"><div className="stat"><span>{t("当前套餐")}</span><strong>{me.entitlements.plan === 'plus' ? 'PLUS' : t("普通账户")}</strong></div><div className="stat"><span>{t("常规翻译")}</span><strong>{me.entitlements.modes.classic.unlimited ? t("不限累计页数") : `${me.entitlements.modes.classic.quota?.available ?? 0}${t(' 页可用')}`}</strong></div><div className="stat"><span>{t("AI 重绘可用额度")}</span><strong>{me.entitlements.modes.redraw.quota?.available ?? 0}{t("页")}</strong></div></div>
      <div className="account-detail"><h3>{t("你的阅读权益")}</h3><p>{t("PLUS 权益到期：")}{date(me.entitlements.plus_expires_at,locale)}{t("（北京时间）")}</p><p>{t("每滚动 60 秒最多新增")}{me.entitlements.image_rate_limit.limit}{t("张翻译图片，跨模式、语言和设备合计。额度以服务端当前状态为准。")}</p><a className="button compact" href={local('/download/')}>{t("打开下一段故事 ↗")}</a><button className="button compact secondary" disabled={busy || loading} onClick={() => void load()}>{t("刷新权益")}</button></div>
      <div className="account-detail"><h3>{t("PLUS 订阅")}</h3>{!billing ? <p>{t("暂时无法读取订阅状态，请刷新重试。")}</p> : !billing.enabled ? <p>{t("订阅服务当前不可用。已有权益不受此提示影响，如需帮助请联系 comics@nodelane.net。")}</p> : billing.subscription && hasManagedSubscription(billing.subscription.status,billing.entitlement_expires_at) ? <>
        <p>{offerLabel(billing.subscription.price,locale)}</p><p>{t("当前状态：")}{subscriptionStatusLabel(billing.subscription.status,locale)}</p><p>{t("下次计费：")}{date(billing.subscription.next_billed_at,locale)}{t("（北京时间）")}</p>{billing.subscription.cancel_at && <p>{t("已安排取消续费：")}{date(billing.subscription.cancel_at,locale)}{t("（北京时间）")}</p>}
        <p>{channelLabel(locale)}：{providerLabel(billing.subscription.provider)}</p>
        <button className="button compact secondary" disabled={busy} onClick={() => void action(async () => { const provider=billing.subscription!.provider;const result=await api<{url:string;provider:BillingProvider}>('/v1/billing/portal','POST',{provider});if(result.provider!==provider)throw Error('结账地址无效，请联系支持。');location.assign(checkoutUrl(result.url,provider,true)); })}>{manageLabel(locale)} · {providerLabel(billing.subscription.provider)} ↗</button>
      </> : <>{!billing.checkout_pending&&billing.offers.length>0&&<><BillingCycle offers={available} value={cycle} locale={locale} disabled={busy} onChange={value=>{setPreferredCycle(value);setSelectedPrice('');setConsent(false);}}/><div className="billing-plan-picker" role="group" aria-label={billingText.plan}>{visibleOffers.map(p=><button type="button" className="billing-plan-card" key={p.id} aria-pressed={offer?.id===p.id} disabled={busy} onClick={()=>{setSelectedPrice(p.id);setConsent(false);}}><strong>{offerLabel(p,locale)}</strong><span>{billingText.quota(p.monthly_redraw_pages)}</span></button>)}</div></>}{offer?<><p>{offerLabel(offer,locale)}</p><p>{billingText.classic} · {billingText.quota(offer.monthly_redraw_pages)}</p><p>{billing.trial_eligible&&channel&&channel.trial_days>0&&billingText.trial(channel.trial_days,channel.trial_redraw_pages)} {billingText.renew(offer.interval==='year')}{t("可在下次续费前取消，税费及应付金额以结账页为准。")}</p></>:<p>{billingText.unavailable}</p>}<label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} /><span>{t("我已阅读")}<a className="text-link" href={local('/refund/')}>{t("订阅与退款说明")}</a>{t("，了解自动续费规则。")}</span></label><button className="button" disabled={busy || !consent || !offer || !channel} onClick={() => void action(async () => { const provider=channel!.provider;const result = await api<{checkout_url:string;provider:BillingProvider}>('/v1/billing/checkouts','POST',{price_id:offer!.id,provider});if(result.provider!==provider)throw Error('结账地址无效，请联系支持。');location.assign(checkoutUrl(result.checkout_url,provider)); })}>{billing.checkout_pending ? t("继续原结账") : t("前往安全结账")} ↗</button></>}
      </div><p className="image-note" style={{ marginTop: 20 }}>{t("退出仅清除官网当前标签页的账户会话，不会取消订阅，也不会退出插件或身份服务中的其他应用。")}</p>
    </>}
  </div>;
}
