import { useEffect, useRef, useState } from 'react';
import { api, ApiError, finishLogin, sessionIdentity, signIn, signOut, loginReturnPath, subscribeAuth, type AuthIdentity } from '../lib/auth';
import { checkoutUrl } from '../lib/auth-config';
import {billingCopy,billingBenefitCopy,offerLabel,offerBenefits,providerLabel,manageLabel,hasManagedSubscription,subscriptionStatusLabel,type Billing,type BillingProvider,type MembershipGift,type PurchaseQuota} from '../lib/billing';
import {quotaPurchaseCopy} from '../i18n/quota-purchase';
import {subscriptionQuotaCopy} from '../i18n/subscription-quota';
interface Entitlements {plan:string;free_quota?:PurchaseQuota;subscription_quota?:PurchaseQuota&{unlimited:boolean};service_plan?:string;purchase_quota?:PurchaseQuota|null;plus_expires_at:string|null;gift?:MembershipGift|null;hourly_image_rate_limit?:{window_seconds:number;limit:number}|null}
interface Me { user: { id: string; name: string }; entitlements: Entitlements }
interface SyncedAccount {billing:Billing;entitlements:Entitlements}
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
  const [billingLoading,setBillingLoading]=useState(false),[billingError,setBillingError]=useState('');
  const [confirmCancel,setConfirmCancel]=useState(false);
  const gift=billing?billing.gift:me?.entitlements.gift;
  const subscription=billing?.subscription;
  const benefitText=billingBenefitCopy(locale);
  const quotaText=quotaPurchaseCopy(locale),quotaCopy=subscriptionQuotaCopy(locale);
  const epoch = useRef(0);
  const accountIdentity=useRef<AuthIdentity|null>(null);
  const billingRevision=useRef(0),billingOperation=useRef(0),syncFlight=useRef<{id:string}|null>(null),actionFlight=useRef(false);
  const initialized = useRef(false);
  function reset(){
    const current=++epoch.current;
    billingRevision.current++;accountIdentity.current=null;actionFlight.current=false;
    setMe(null);setBilling(null);setLoading(false);setBillingLoading(false);setBillingError('');setBusy(false);setConfirmCancel(false);
    return current;
  }
  function accountFailed(err:unknown,current:number){
    if(current!==epoch.current)return;
    reset();setError(t(message(err)));
  }
  function read(identity:AuthIdentity,current:number,billingOnly=false){
    const revision=++billingRevision.current,operation=++billingOperation.current;
    setBillingLoading(true);setBillingError('');
    const get=async<T,>(part:'account'|'billing',path:string,publish:(value:T)=>void)=>{
      try{
        const value=await api<T>(path,'GET',undefined,undefined,identity);
        if(current===epoch.current&&(part==='account'||revision===billingRevision.current))publish(value);
      }catch(err){
        if(current!==epoch.current)return;
        if(part==='account'||err instanceof ApiError&&err.status===401)accountFailed(err,current);
        else if(revision===billingRevision.current)setBillingError(t(message(err)));
      }finally{
        if(current!==epoch.current)return;
        if(part==='account')setLoading(false);
        else if(operation===billingOperation.current)setBillingLoading(false);
      }
    };
    // Publish each local snapshot independently; billing never gates account visibility.
    return Promise.all([...(billingOnly?[]:[get('account','/v1/me',setMe)]),get('billing','/v1/billing/status',setBilling)]);
  }
  async function load() {
    const current = reset();
    setLoading(true); setError('');
    try {
      const identity=await sessionIdentity();
      if(current!==epoch.current||!identity)return;
      accountIdentity.current=identity;
      await read(identity,current);
    } catch (err) { accountFailed(err,current); }
    finally { if (current === epoch.current) setLoading(false); }
  }
  async function refreshBilling(){
    const identity=accountIdentity.current;
    if(!identity||actionFlight.current||syncFlight.current?.id===identity.id)return;
    const current=epoch.current,revision=++billingRevision.current,operation=++billingOperation.current;
    const active={id:identity.id};syncFlight.current=active;
    setBillingLoading(true);setBillingError('');
    try{
      const value=await api<SyncedAccount>('/v1/billing/sync','POST',undefined,undefined,identity);
      if(current===epoch.current&&revision===billingRevision.current){setBilling(value.billing);setMe(previous=>previous?{...previous,entitlements:value.entitlements}:null);}
    }catch(err){
      if(current!==epoch.current)return;
      if(err instanceof ApiError&&err.status===401)accountFailed(err,current);
      else if(revision===billingRevision.current)setBillingError(t(message(err)));
    }finally{
      if(syncFlight.current===active)syncFlight.current=null;
      if(current===epoch.current&&operation===billingOperation.current)setBillingLoading(false);
    }
  }
  useEffect(() => {
    if (callback) {
      if (initialized.current) return;
      initialized.current = true;
      void finishLogin().then(() => location.replace(loginReturnPath())).catch(err => { setError(t(message(err))); setLoading(false); });
      return;
    }
    const unsubscribe=subscribeAuth(()=>void load());
    void load();
    return()=>{epoch.current++;unsubscribe();};
  }, [callback]);

  async function action(work: (isCurrent:()=>boolean) => Promise<void>,billingAction=false) {
    if (actionFlight.current||billingAction&&syncFlight.current?.id===accountIdentity.current?.id) return;
    actionFlight.current=true;
    const current=epoch.current,isCurrent=()=>current===epoch.current;
    setBusy(true); setError('');
    try { await work(isCurrent); } catch (err) {
      if(!isCurrent())return;
      if (err instanceof ApiError && err.status === 401)accountFailed(err,current);
      else setError(t(message(err)));
    } finally { if(isCurrent()){actionFlight.current=false;setBusy(false);} }
  }
  if (callback) return <div className="status-panel" role="status">{loading ? t("正在确认登录结果，请稍候…") : <><p>{error}</p><a className="text-link" href={local('/account/')}>{t("返回账户重新登录 ↗")}</a></>}</div>;
  return <div className="website-account" aria-busy={loading || busy}>
    {error && <div className="status-panel error" role="alert">{error} <button className="button compact secondary" disabled={busy || loading} onClick={() => void load()}>{t("重试连接")}</button></div>}
    {loading ? <div className="loading" role="status">{t("正在读取你的账户…")}</div> : !me ? <div className="login-passport"><div className="login-cover"><p className="eyebrow">NODELANE COMICS / READER PASS</p><h2>{t("下一页，")}<br />{t("读懂新世界。")}</h2><div className="login-ticket">{t("あ → 你好")}</div><p>{t("一个账户，连接官网与插件。")}<br />{t("你的翻译权益，都在这里。")}</p></div><div className="login-form"><p className="eyebrow">WELCOME BACK</p><h2>{t("打开你的读者通行证")}</h2><p>{t("前往统一身份服务安全登录，完成后自动回到这里。")}</p><button className="button" disabled={busy} onClick={() => void action(() => signIn(accountHref+location.search))}>{busy ? t("正在前往登录…") : t("登录 / 注册")} <span aria-hidden="true">↗</span></button><small>{t("继续前请阅读")}<a className="text-link" href={local('/terms/')}>{t("服务条款")}</a>{t("与")}<a className="text-link" href={local('/privacy/')}>{t("隐私政策")}</a>{t("。官网不会收集你的登录密码。")}</small></div></div> : <>
      <section className="account-summary" aria-label={t("账户信息")}>
        <div className="account-identity"><span className="account-avatar" aria-hidden="true">{me.user.name.slice(0,1).toUpperCase()}</span><div><h2>{me.user.name}</h2><span className="account-plan" data-plus={me.entitlements.plan!=='free'}>{me.entitlements.plan==='plus'?'PLUS':me.entitlements.plan==='lite'?'Lite':t("普通账户")}</span></div><button className="account-signout" disabled={busy} onClick={() => void action(async () => { await signOut(); })}>{t("退出登录")}</button></div>
        {me.entitlements.plan!=='free'&&me.entitlements.plus_expires_at&&<p className="account-expiry">{t("会员有效期至")}{date(me.entitlements.plus_expires_at,locale)}{t("（北京时间）")}</p>}
        {me.entitlements.hourly_image_rate_limit&&<p className="account-rate-limit">{benefitText.hourly(me.entitlements.hourly_image_rate_limit.limit)}</p>}
        {me.entitlements.service_plan&&<p>{quotaText.currentService.replace('{0}',me.entitlements.service_plan==='free'?t('普通账户'):me.entitlements.service_plan)}</p>}
        {([['free_quota',quotaCopy.free],['subscription_quota',quotaCopy.subscription]] as const).map(([key,title])=>{const balance=me.entitlements[key];return balance&&<div className="account-gift" key={key}><strong>{title}</strong><p>{'unlimited' in balance&&balance.unlimited?billingCopy(locale).classic:quotaText.pages.replace('{0}',balance.available.toLocaleString(locale))}</p></div>;})}
        <p className="muted">{quotaCopy.rule}</p>
        {me.entitlements.purchase_quota&&<div className="account-gift"><strong>{quotaText.title}</strong><p>{quotaText.remaining.replace('{0}',me.entitlements.purchase_quota.available.toLocaleString(locale)).replace('{1}',me.entitlements.purchase_quota.reserved.toLocaleString(locale))}</p>{me.entitlements.purchase_quota.next_expiry_at?<p>{quotaText.nextExpiry.replace('{0}',date(me.entitlements.purchase_quota.next_expiry_at,locale))}{t('（北京时间）')}</p>:me.entitlements.purchase_quota.available>0&&<p>{quotaText.noExpiry}</p>}<p>{quotaText.subscription}</p></div>}
        {gift&&gift.state!=='expired'&&<div className="account-gift"><strong>{t('赠送 PLUS {0} 天').replace('{0}',String(gift.days))}</strong>{gift.state==='pending'?<p role="status">{t('赠送安排处理中，请刷新查看。')}</p>:<>{gift.starts_at&&<p>{t('赠送生效：{0}').replace('{0}',date(gift.starts_at,locale))}{t('（北京时间）')}</p>}{gift.ends_at&&<p>{t('赠送结束：{0}').replace('{0}',date(gift.ends_at,locale))}{t('（北京时间）')}</p>}</>}</div>}
        <div className="account-reading-note"><p>{t("阅读、翻译和用量查看，请前往浏览器插件。")}</p><a className="text-link" data-install-extension href={local('/download/')}>{t("下载插件")} ↗</a></div>
      </section>
      <section className="account-subscription" aria-busy={billingLoading}><div className="account-section-heading"><h3>{t("会员订阅")}</h3><button className="account-refresh" disabled={busy||loading||billingLoading||!billing?.enabled} onClick={()=>void refreshBilling()}>{t("刷新")}</button></div>
        {billingLoading&&<p role="status">{t('订阅状态')}…</p>}
        {billingError&&<div className="status-panel error" role="alert">{billingError} <button className="button compact secondary" disabled={busy||billingLoading} onClick={()=>{const identity=accountIdentity.current;if(identity)void read(identity,epoch.current,true);}}>{t('重试连接')}</button></div>}
        {!billing ? !billingLoading&&!billingError&&<p>{t("暂时无法读取订阅状态，请刷新重试。")}</p> : !billing.enabled ? <p>{t("订阅服务当前不可用。已有权益不受此提示影响，如需帮助请联系 comics@nodelane.net。")}</p> : billing.subscription && hasManagedSubscription(billing.subscription.status,billing.entitlement_expires_at) ? <>
        <p className="subscription-price">{offerLabel(billing.subscription.price,locale)}</p>
        <p>{offerBenefits(billing.subscription.price,locale)}</p>
        <dl className="subscription-facts"><div><dt>{t("订阅状态")}</dt><dd>{subscriptionStatusLabel(billing.subscription.status,locale)}</dd></div></dl>
        {subscription?.paid_ends_at&&<p>{t('已付费权益至 {0}').replace('{0}',date(subscription.paid_ends_at,locale))}{t('（北京时间）')}</p>}
        {subscription?.renewal_state==='deferring'?<p role="status">{t('续费延期处理中，请刷新查看。')}</p>:subscription?.renewal_state==='resuming'?<p role="status">{t('正在恢复续费，请刷新查看。')}</p>:subscription?.renewal_state==='canceling'?<p role="status">{t('正在取消续费，请刷新查看。')}</p>:subscription?.renewal_state==='attention'?<p role="status">{t('续费安排需要核实，请刷新或联系支持。')}</p>:subscription?.auto_renew?<>{subscription.renewal_state==='deferred'&&<p>{t('赠送期间不扣款，结束后恢复自动续费。')}</p>}{subscription.resume_at?<p>{t('预计恢复续费：{0}').replace('{0}',date(subscription.resume_at,locale))}{t('（北京时间）')}</p>:subscription.next_billed_at&&<p>{t('下次续费：{0}').replace('{0}',date(subscription.next_billed_at,locale))}{t('（北京时间）')}</p>}</>:<p>{t('已关闭自动续费，已付款及赠送权益保留。')}</p>}
        <button className="button compact secondary" disabled={busy||billingLoading} onClick={() => void action(async isCurrent => { const identity=accountIdentity.current;if(!identity)return;const provider=billing.subscription!.provider;const result=await api<{url:string;provider:BillingProvider}>('/v1/billing/portal','POST',{provider},undefined,identity);if(!isCurrent())return;if(result.provider!==provider)throw Error('结账地址无效，请联系支持。');location.assign(checkoutUrl(result.url,provider,true)); },true)}>{manageLabel(locale)} · {providerLabel(billing.subscription.provider)} ↗</button>
        {subscription?.auto_renew&&subscription.can_cancel&&<button className="button compact secondary" disabled={busy||billingLoading||confirmCancel} onClick={()=>setConfirmCancel(true)}>{t('取消自动续费')}</button>}
        {confirmCancel&&subscription?.auto_renew&&subscription.can_cancel&&<div role="group" aria-label={t('取消自动续费')}><p>{t('取消后保留已付款及赠送权益，到期后不再扣款。')}</p><button className="button compact secondary" disabled={busy||billingLoading} onClick={()=>void action(async isCurrent=>{const identity=accountIdentity.current;if(!identity)return;billingRevision.current++;setConfirmCancel(false);const value=await api<Billing>('/v1/billing/cancel-renewal','POST',{provider:subscription.provider},undefined,identity);if(isCurrent())setBilling(value);},true)}>{t('确认取消续费')}</button><button className="button compact secondary" disabled={busy||billingLoading} onClick={()=>setConfirmCancel(false)}>{t('保留自动续费')}</button></div>}
      </> : gift&&gift.state!=='expired' ? <p>{t("赠送结束后可开通订阅。")}</p> : null}
      </section><div className="account-purchase-link"><p>{quotaText.pricingHint}</p><a className="button" href={local('/pricing/')}>{quotaText.pricingLink} ↗</a></div><p className="account-session-note">{t("退出仅清除官网当前标签页的账户会话，不会取消订阅，也不会退出插件或身份服务中的其他应用。")}</p>
    </>}
  </div>;
}
