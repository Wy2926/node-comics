import { commerceCopy, formatCopy } from '../i18n/commerce';
export type BillingProvider='stripe'|'creem';
export interface BillingChannel {provider:BillingProvider;binding_id:string;trial_days:number;trial_redraw_pages:number}
export interface BillingPrice {id:string;name:string;currency:string;unit_amount:number;interval:'month'|'year';monthly_redraw_pages:number;trial_days:number;trial_redraw_pages:number;plan_id?:string;hourly_image_limit?:number|null}
export interface BillingOffer extends BillingPrice {plan_id:string;plan_revision_id:string;channels:BillingChannel[]}
export interface MembershipGift {starts_at:string|null;ends_at:string|null;days:number;state:'pending'|'scheduled'|'active'|'expired'}
export interface Billing {enabled:boolean;providers:{id:BillingProvider;label:string;environment:'test'|'live'}[];provider:BillingProvider|null;environment:'test'|'live';trial_eligible:boolean;checkout_pending:boolean;checkout_provider:BillingProvider|null;checkout_price:BillingOffer|null;offers:BillingOffer[];entitlement_expires_at:string|null;gift:MembershipGift|null;subscription:{provider:BillingProvider;price:BillingPrice;status:string;next_billed_at:string|null;cancel_at:string|null;paid_ends_at:string|null;trial_ends_at:string|null;auto_renew:boolean;can_cancel:boolean;renewal_state:'normal'|'deferring'|'deferred'|'resuming'|'canceling'|'canceled'|'attention';resume_at:string|null}|null}
export const providerLabel=(provider:BillingProvider)=>provider==='creem'?'Creem':'Stripe';
export const channelLabel=(locale:string)=>commerceCopy(locale)?.channel??({'zh-CN':'支付渠道','zh-TW':'付款渠道',en:'Payment provider',ja:'決済サービス',ko:'결제 서비스'}[locale]??'Payment provider');
export const manageLabel=(locale:string)=>commerceCopy(locale)?.manage??({'zh-CN':'管理订阅','zh-TW':'管理訂閱',en:'Manage subscription',ja:'購読を管理',ko:'구독 관리'}[locale]??'Manage subscription');
export function selectedChannel(offer:BillingOffer|undefined,preferred:BillingProvider|'',pending:BillingProvider|null=null){
  return offer?.channels.find(channel=>channel.provider===(pending??preferred))??(pending?undefined:offer?.channels[0]);
}
export function hasManagedSubscription(status:string|undefined,entitlementExpiresAt:string|null|undefined,now=Date.now()){
  return !!status&&(['active','trialing','past_due','unpaid','paused','incomplete','scheduled_cancel'].includes(status)||!!entitlementExpiresAt&&Date.parse(entitlementExpiresAt)>now);
}
export function subscriptionStatusLabel(status:string,locale:string){
  const index:Record<string,number>={active:0,trialing:1,past_due:2,unpaid:2,incomplete:2,paused:3,scheduled_cancel:4,canceled:5,expired:6,incomplete_expired:6};
  const text:Record<string,string[]>={
    'zh-CN':['订阅生效中','试用中','账单待处理','订阅已暂停','已安排取消续费','已取消续费','订阅已到期','正在核实订阅'],
    'zh-TW':['訂閱生效中','試用中','帳單待處理','訂閱已暫停','已安排取消續訂','已取消續訂','訂閱已到期','正在確認訂閱'],
    en:['Active','Trialing','Payment pending','Subscription paused','Cancellation scheduled','Renewal canceled','Subscription ended','Checking subscription'],
    ja:['有効','体験期間中','支払い確認待ち','購読一時停止中','更新停止予定','自動更新停止済み','購読終了','購読を確認中'],
    ko:['활성','체험 중','결제 대기','구독 일시 중지','갱신 취소 예정','갱신 취소됨','구독 종료','구독 확인 중'],
  };
  return (commerceCopy(locale)?.statuses??text[locale]??text.en)[index[status]??7];
}
const labels:Record<string,{plan:string;month:string;year:string;unavailable:string;loading:string;error:string;classic:string;quota:(n:number)=>string;trial:(days:number,pages:number)=>string;renew:(annual:boolean)=>string}>={
  'zh-CN':{plan:'订阅套餐',month:'月',year:'年',unavailable:'订阅暂未开放',loading:'正在读取套餐…',error:'暂时无法读取套餐，请刷新重试。',classic:'常规翻译不限页数',quota:n=>`每月 ${n} 页 AI 重绘，剩余不累积`,trial:(d,p)=>`首次绑卡试用 ${d} 天，含 ${p} 页重绘。`,renew:a=>a?'按年自动续费，重绘额度逐月生效。':'按月自动续费。'},
  'zh-TW':{plan:'訂閱方案',month:'月',year:'年',unavailable:'訂閱尚未開放',loading:'正在讀取方案…',error:'暫時無法讀取方案，請重新整理。',classic:'一般翻譯不限頁數',quota:n=>`每月 ${n} 頁 AI 重繪，餘額不累積`,trial:(d,p)=>`首次綁卡試用 ${d} 天，含 ${p} 頁重繪。`,renew:a=>a?'按年自動續訂，重繪額度逐月生效。':'按月自動續訂。'},
  en:{plan:'Subscription plan',month:'month',year:'year',unavailable:'Subscriptions are not available yet',loading:'Loading plans…',error:'Unable to load plans. Please refresh.',classic:'Unlimited classic translation',quota:n=>`${n} AI redraw pages each month, with no rollover`,trial:(d,p)=>`First card-backed trial: ${d} days and ${p} redraw pages.`,renew:a=>a?'Renews annually. Redraw quotas become available monthly.':'Renews monthly.'},
  ja:{plan:'購読プラン',month:'月',year:'年',unavailable:'購読受付は準備中です',loading:'プランを読み込み中…',error:'プランを取得できません。再読み込みしてください。',classic:'通常翻訳はページ数無制限',quota:n=>`AI 再描画は毎月 ${n} ページ、繰り越しなし`,trial:(d,p)=>`カード登録による初回体験は ${d} 日間、再描画 ${p} ページ。`,renew:a=>a?'毎年自動更新。再描画枠は毎月有効になります。':'毎月自動更新。'},
  ko:{plan:'구독 요금제',month:'월',year:'년',unavailable:'구독 서비스 준비 중',loading:'요금제 불러오는 중…',error:'요금제를 불러올 수 없습니다. 새로고침해 주세요.',classic:'일반 번역 페이지 무제한',quota:n=>`매월 AI 다시 그리기 ${n}페이지, 이월 불가`,trial:(d,p)=>`카드 등록 첫 체험 ${d}일, 다시 그리기 ${p}페이지 포함.`,renew:a=>a?'매년 자동 갱신되며 다시 그리기 한도는 매월 제공됩니다.':'매월 자동 갱신됩니다.'},
};
export function billingCopy(locale:string) {
 const copy=commerceCopy(locale)?.billing;
 return copy ? {...copy,quota:(n:number)=>formatCopy(copy.quota,{n}),trial:(d:number,p:number)=>formatCopy(copy.trial,{d,p}),renew:(annual:boolean)=>annual?copy.renewAnnual:copy.renewMonthly} : labels[locale]??labels.en;
}
const benefitLabels = {
  'zh-CN': {hourly:(n:number)=>`每滚动小时最多新增 ${n.toLocaleString('zh-CN')} 页翻译`,noRedraw:'不含 AI 重绘',annual:'按年自动续费。',trial:(d:number)=>`符合条件的首次账户可绑卡试用 ${d} 天。`,subscribe:(name:string)=>`开通 ${name}`,description:'专注常规翻译，按小时控制新任务受理量。',intro:'选择翻译套餐，在插件中使用订阅权益。'},
  'zh-TW': {hourly:(n:number)=>`每滾動小時最多新增 ${n.toLocaleString('zh-TW')} 頁翻譯`,noRedraw:'不含 AI 重繪',annual:'按年自動續訂。',trial:(d:number)=>`符合資格的首次帳戶可綁卡試用 ${d} 天。`,subscribe:(name:string)=>`訂閱 ${name}`,description:'專注一般翻譯，按小時限制新任務受理量。',intro:'選擇翻譯方案，在擴充功能中使用訂閱權益。'},
  en: {hourly:(n:number)=>`Up to ${n.toLocaleString('en')} new translation pages per rolling hour`,noRedraw:'AI redraw not included',annual:'Renews annually.',trial:(d:number)=>`Eligible first-time accounts can try ${d} days. Card required.`,subscribe:(name:string)=>`Get ${name}`,description:'Classic translation with an hourly limit on new translation requests.',intro:'Choose a translation plan to use your subscription benefits in the extension.'},
  ja: {hourly:(n:number)=>`直近1時間の新規翻訳受付は最大 ${n.toLocaleString('ja')} ページ`,noRedraw:'AI 再描画は含まれません',annual:'毎年自動更新。',trial:(d:number)=>`対象の初回アカウントはカード登録で ${d} 日間体験できます。`,subscribe:(name:string)=>`${name} に登録`,description:'通常翻訳向け。新規タスクの受付数に時間ごとの上限があります。',intro:'翻訳プランを選び、拡張機能で購読特典を利用できます。'},
  ko: {hourly:(n:number)=>`최근 1시간 동안 새 번역 요청 최대 ${n.toLocaleString('ko')}페이지`,noRedraw:'AI 다시 그리기 미포함',annual:'매년 자동 갱신됩니다.',trial:(d:number)=>`조건에 맞는 첫 계정은 카드 등록으로 ${d}일간 체험할 수 있습니다.`,subscribe:(name:string)=>`${name} 구독`,description:'일반 번역을 위한 요금제이며 새 작업 요청에 시간당 한도가 적용됩니다.',intro:'번역 요금제를 선택하고 확장 프로그램에서 구독 혜택을 이용하세요.'},
};
export function billingBenefitCopy(locale:string) {
 const copy=commerceCopy(locale)?.billingBenefits;
 return copy ? {...copy,hourly:(n:number)=>formatCopy(copy.hourly,{n:n.toLocaleString(locale)}),trial:(d:number)=>formatCopy(copy.trial,{d}),subscribe:(name:string)=>formatCopy(copy.subscribe,{name})} : benefitLabels[locale as keyof typeof benefitLabels]??benefitLabels.en;
}
export function redrawBenefit(offer:Pick<BillingPrice,'monthly_redraw_pages'>,locale:string){
  return offer.monthly_redraw_pages>0?billingCopy(locale).quota(offer.monthly_redraw_pages):billingBenefitCopy(locale).noRedraw;
}
export function offerBenefits(offer:Pick<BillingPrice,'hourly_image_limit'|'monthly_redraw_pages'>,locale:string){
  const classic=offer.hourly_image_limit?billingBenefitCopy(locale).hourly(offer.hourly_image_limit):billingCopy(locale).classic;
  return `${classic} · ${redrawBenefit(offer,locale)}`;
}
export function renewalCopy(offer:Pick<BillingPrice,'interval'|'monthly_redraw_pages'>,locale:string){
  return offer.interval==='year'&&offer.monthly_redraw_pages===0?billingBenefitCopy(locale).annual:billingCopy(locale).renew(offer.interval==='year');
}
export function trialCopy(days:number,pages:number,locale:string){
  return pages>0?billingCopy(locale).trial(days,pages):billingBenefitCopy(locale).trial(days);
}
export function amount(offer:BillingPrice,locale:string){const f=new Intl.NumberFormat(locale,{style:'currency',currency:offer.currency});const digits=['isk','ugx'].includes(offer.currency)?2:f.resolvedOptions().maximumFractionDigits??2;return f.format(offer.unit_amount/10**digits);}
export const offerLabel=(offer:BillingPrice,locale:string)=>`${offer.name} · ${amount(offer,locale)} / ${offer.interval==='year'?billingCopy(locale).year:billingCopy(locale).month}`;

// Compare published quotes only when they buy the same benefits in the same currency.
export function annualSavings(offer:BillingOffer,offers:BillingOffer[]){
  if(offer.interval!=='year')return null;
  const monthly=offers.filter(p=>p.interval==='month'&&p.plan_id===offer.plan_id&&p.plan_revision_id===offer.plan_revision_id&&p.currency===offer.currency&&p.unit_amount>0);
  if(!monthly.length)return null;
  const regular=Math.min(...monthly.map(p=>p.unit_amount))*12;
  const saved=regular-offer.unit_amount;
  return saved>0?{regular,saved,percent:Math.round(saved/regular*1000)/10}:null;
}
