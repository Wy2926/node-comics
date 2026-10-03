import { commerceCopy, formatCopy } from '../i18n/commerce';
const labels={
  'zh-CN':{monthly:'折合每月',save:(p:number)=>`年付约省 ${p}%`,saving:(a:string)=>`比连续月付 12 个月省 ${a}`,billed:(a:string)=>`每年支付 ${a}`,total:'连续月付一年',cancel:'可在下次续费前取消。'},
  'zh-TW':{monthly:'平均每月',save:(p:number)=>`年付約省 ${p}%`,saving:(a:string)=>`比連續月付 12 個月省 ${a}`,billed:(a:string)=>`每年支付 ${a}`,total:'連續月付一年',cancel:'可在下次續訂前取消。'},
  en:{monthly:'Monthly equivalent',save:(p:number)=>`Save ≈${p}% yearly`,saving:(a:string)=>`Save ${a} compared with 12 monthly payments`,billed:(a:string)=>`Billed ${a} per year`,total:'12 monthly payments',cancel:'Cancel before your next renewal.'},
  ja:{monthly:'月額換算',save:(p:number)=>`年払いで約 ${p}% お得`,saving:(a:string)=>`月払い12回より ${a} お得`,billed:(a:string)=>`年額 ${a} をお支払い`,total:'月払い12回分',cancel:'次回更新前に解約できます。'},
  ko:{monthly:'월 환산 요금',save:(p:number)=>`연간 약 ${p}% 절약`,saving:(a:string)=>`월간 결제 12회보다 ${a} 절약`,billed:(a:string)=>`매년 ${a} 결제`,total:'월간 결제 12회',cancel:'다음 갱신 전에 취소할 수 있습니다.'},
};
export function pricingCopy(locale:string) {
  const copy=commerceCopy(locale)?.pricing;
  return copy ? {...copy,save:(n:number)=>formatCopy(copy.save,{n}),saving:(a:string)=>formatCopy(copy.saving,{a}),billed:(a:string)=>formatCopy(copy.billed,{a})} : labels[locale as keyof typeof labels]??labels.en;
}
const publishedLabels={
  'zh-CN':{label:'Lite 公开价格 · 美元（USD）',monthly:'月付',yearly:'年付',annualPayment:'每年一次支付，自动续费。',loading:'正在确认购买状态…',unavailable:'在线订阅当前不可用',error:'暂时无法确认购买状态，请刷新重试。已公布价格仍可查看。',unconfirmedTiming:'购买状态以实时套餐为准，请刷新本页重试，或在官网、插件账户页查看订阅状态。',checking:'等待确认购买状态',noScript:'启用 JavaScript 后可查看实时购买状态。',tax:'税费及最终应付金额以结账页为准。'},
  'zh-TW':{label:'Lite 公開價格 · 美元（USD）',monthly:'月付',yearly:'年付',annualPayment:'每年一次付款，自動續訂。',loading:'正在確認購買狀態…',unavailable:'線上訂閱目前無法使用',error:'暫時無法確認購買狀態，請重新整理。仍可查看已公布價格。',unconfirmedTiming:'購買狀態以即時方案為準，請重新整理本頁，或在官網、擴充功能帳戶頁查看訂閱狀態。',checking:'等待確認購買狀態',noScript:'啟用 JavaScript 後可查看即時購買狀態。',tax:'稅費及最終應付金額以結帳頁為準。'},
  en:{label:'Published Lite prices · US dollars (USD)',monthly:'Monthly',yearly:'Yearly',annualPayment:'One annual payment. Renews automatically.',loading:'Checking purchase availability…',unavailable:'Online subscriptions are currently unavailable',error:'Unable to confirm purchase availability. Please refresh. Published prices remain visible.',unconfirmedTiming:'Current offers determine purchase availability. Refresh this page or check subscriptions in your website or extension account.',checking:'Awaiting purchase availability',noScript:'Enable JavaScript to check current purchase availability.',tax:'Taxes and the final amount are shown at checkout.'},
  ja:{label:'Lite 公開価格 · 米ドル（USD）',monthly:'月払い',yearly:'年払い',annualPayment:'年額を一括払い。自動更新。',loading:'購入受付状況を確認中…',unavailable:'オンライン購読は現在利用できません',error:'購入受付状況を確認できません。再読み込みしてください。公開価格は引き続きご覧いただけます。',unconfirmedTiming:'最新のプランで購入受付状況をご確認ください。再読み込みするか、公式サイトや拡張機能のアカウントページで購読状況をご確認ください。',checking:'購入受付状況の確認待ち',noScript:'最新の購入受付状況を確認するには JavaScript を有効にしてください。',tax:'税金と最終支払額は決済画面に表示されます。'},
  ko:{label:'Lite 공개 요금 · 미국 달러(USD)',monthly:'월간 결제',yearly:'연간 결제',annualPayment:'연 1회 일시불 결제. 자동 갱신됩니다.',loading:'구매 가능 여부 확인 중…',unavailable:'현재 온라인 구독을 이용할 수 없습니다',error:'구매 가능 여부를 확인할 수 없습니다. 새로고침해 주세요. 공개 요금은 계속 확인할 수 있습니다.',unconfirmedTiming:'현재 요금제에 따라 구매 가능 여부가 결정됩니다. 페이지를 새로고침하거나 웹사이트 또는 확장 프로그램의 계정 페이지에서 구독 상태를 확인하세요.',checking:'구매 가능 여부 확인 대기',noScript:'최신 구매 가능 여부를 확인하려면 JavaScript를 활성화하세요.',tax:'세금 및 최종 결제 금액은 결제 화면에 표시됩니다.'},
};
export const publishedPricingCopy=(locale:string)=>commerceCopy(locale)?.publishedPricing??publishedLabels[locale as keyof typeof publishedLabels]??publishedLabels.en;
