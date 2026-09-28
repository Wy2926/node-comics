const labels = {
  'zh-CN': {quota:'重绘额度每月发放，剩余不累积；年付也逐月生效。',subscribe:'开通 PLUS',monthly:'折合每月',save:(p:number)=>`年付约省 ${p}%`,saving:(a:string)=>`比连续月付 12 个月省 ${a}`,billed:(a:string)=>`每年支付 ${a}`,total:'连续月付一年',trial:(d:number,p:number)=>`符合条件的首次账户可绑卡试用 ${d} 天，含 ${p} 页重绘。`,cancel:'可在下次续费前取消。'},
  'zh-TW': {quota:'重繪額度每月提供，餘額不累積；年付也逐月生效。',subscribe:'訂閱 PLUS',monthly:'平均每月',save:(p:number)=>`年付約省 ${p}%`,saving:(a:string)=>`比連續月付 12 個月省 ${a}`,billed:(a:string)=>`每年支付 ${a}`,total:'連續月付一年',trial:(d:number,p:number)=>`符合資格的首次帳戶可綁卡試用 ${d} 天，含 ${p} 頁重繪。`,cancel:'可在下次續訂前取消。'},
  en: {quota:'Redraw pages are released monthly with no rollover, including on yearly plans.',subscribe:'Get PLUS',monthly:'Monthly equivalent',save:(p:number)=>`Save ≈${p}% yearly`,saving:(a:string)=>`Save ${a} compared with 12 monthly payments`,billed:(a:string)=>`Billed ${a} per year`,total:'12 monthly payments',trial:(d:number,p:number)=>`Eligible first-time accounts can try ${d} days with ${p} redraw pages. Card required.`,cancel:'Cancel before your next renewal.'},
  ja: {quota:'再描画枠は毎月付与、繰り越しなし。年払いも毎月有効になります。',subscribe:'PLUS に登録',monthly:'月額換算',save:(p:number)=>`年払いで約 ${p}% お得`,saving:(a:string)=>`月払い12回より ${a} お得`,billed:(a:string)=>`年額 ${a} をお支払い`,total:'月払い12回分',trial:(d:number,p:number)=>`対象の初回アカウントはカード登録で ${d} 日間、再描画 ${p} ページを体験できます。`,cancel:'次回更新前に解約できます。'},
  ko: {quota:'다시 그리기 한도는 매월 제공되며 이월되지 않습니다. 연간 요금제도 동일합니다.',subscribe:'PLUS 구독',monthly:'월 환산 요금',save:(p:number)=>`연간 약 ${p}% 절약`,saving:(a:string)=>`월간 결제 12회보다 ${a} 절약`,billed:(a:string)=>`매년 ${a} 결제`,total:'월간 결제 12회',trial:(d:number,p:number)=>`조건에 맞는 첫 계정은 카드 등록으로 ${d}일, 다시 그리기 ${p}페이지를 체험할 수 있습니다.`,cancel:'다음 갱신 전에 취소할 수 있습니다.'},
};
export const pricingCopy=(locale:string)=>labels[locale as keyof typeof labels]??labels.en;

const publishedLabels = {
  'zh-CN': {
    label:'PLUS 公开价格 · 美元（USD）', monthly:'月付', yearly:'年付', annualPayment:'每年一次支付，自动续费。',
    loading:'正在确认购买状态…', unavailable:'在线订阅尚未开放', error:'暂时无法确认购买状态，请刷新重试。已公布价格仍可查看。',
    launch:(date:string)=>`计划于北京时间 ${date}前开放购买（UTC+8）。`,
    timing:'正式开放后，可在官网或插件账户页购买。', unconfirmedTiming:'当前购买状态尚未确认，请刷新本页重试，或在官网、插件账户页查看订阅状态。',
    comingSoon:'购买即将开放', checking:'等待确认购买状态', noScript:'启用 JavaScript 后可查看实时购买状态。',
    trial:(d:number,p:number)=>`符合条件的首次账户可绑卡试用 ${d} 天，含 ${p} 页 AI 重绘；以购买时的试用资格为准。`, tax:'税费及最终应付金额以结账页为准。',
  },
  'zh-TW': {
    label:'PLUS 公開價格 · 美元（USD）', monthly:'月付', yearly:'年付', annualPayment:'每年一次付款，自動續訂。',
    loading:'正在確認購買狀態…', unavailable:'線上訂閱尚未開放', error:'暫時無法確認購買狀態，請重新整理。仍可查看已公布價格。',
    launch:(date:string)=>`預計於北京時間 ${date}前開放購買（UTC+8）。`,
    timing:'正式開放後，可在官網或擴充功能帳戶頁購買。', unconfirmedTiming:'目前尚未確認購買狀態，請重新整理本頁，或在官網、擴充功能帳戶頁查看訂閱狀態。',
    comingSoon:'即將開放購買', checking:'等待確認購買狀態', noScript:'啟用 JavaScript 後可查看即時購買狀態。',
    trial:(d:number,p:number)=>`符合資格的首次帳戶可綁卡試用 ${d} 天，含 ${p} 頁 AI 重繪；以購買時的試用資格為準。`, tax:'稅費及最終應付金額以結帳頁為準。',
  },
  en: {
    label:'Published PLUS prices · US dollars (USD)', monthly:'Monthly', yearly:'Yearly', annualPayment:'One annual payment. Renews automatically.',
    loading:'Checking purchase availability…', unavailable:'Online subscriptions are not open yet', error:'Unable to confirm purchase availability. Please refresh. Published prices remain visible.',
    launch:(date:string)=>`Purchases are planned to open before ${date}, Beijing time (UTC+8).`,
    timing:'Once open, subscribe from your account on the website or in the extension.', unconfirmedTiming:'Current purchase availability is unconfirmed. Refresh this page or check subscriptions in your website or extension account.',
    comingSoon:'Purchases coming soon', checking:'Awaiting purchase availability', noScript:'Enable JavaScript to check current purchase availability.',
    trial:(d:number,p:number)=>`Eligible first-time accounts can try ${d} days with ${p} AI redraw pages. Card required; eligibility is confirmed at purchase.`, tax:'Taxes and the final amount are shown at checkout.',
  },
  ja: {
    label:'PLUS 公開価格 · 米ドル（USD）', monthly:'月払い', yearly:'年払い', annualPayment:'年額を一括払い。自動更新。',
    loading:'購入受付状況を確認中…', unavailable:'オンライン購読の受付は準備中です', error:'購入受付状況を確認できません。再読み込みしてください。公開価格は引き続きご覧いただけます。',
    launch:(date:string)=>`北京時間（UTC+8）の${date}より前に購入受付を開始する予定です。`,
    timing:'受付開始後は公式サイトまたは拡張機能のアカウントページから購読できます。', unconfirmedTiming:'現在の購入受付状況は未確認です。再読み込みするか、公式サイトや拡張機能のアカウントページで購読状況をご確認ください。',
    comingSoon:'購入受付は近日開始', checking:'購入受付状況の確認待ち', noScript:'最新の購入受付状況を確認するには JavaScript を有効にしてください。',
    trial:(d:number,p:number)=>`対象の初回アカウントはカード登録で ${d} 日間、AI 再描画 ${p} ページを体験できます。対象資格は購入時に確認されます。`, tax:'税金と最終支払額は決済画面に表示されます。',
  },
  ko: {
    label:'PLUS 공개 요금 · 미국 달러(USD)', monthly:'월간 결제', yearly:'연간 결제', annualPayment:'연 1회 일시불 결제. 자동 갱신됩니다.',
    loading:'구매 가능 여부 확인 중…', unavailable:'온라인 구독은 아직 시작되지 않았습니다', error:'구매 가능 여부를 확인할 수 없습니다. 새로고침해 주세요. 공개 요금은 계속 확인할 수 있습니다.',
    launch:(date:string)=>`베이징 시간(UTC+8) 기준 ${date} 전에 구매를 시작할 예정입니다.`,
    timing:'구매가 시작되면 웹사이트 또는 확장 프로그램의 계정 페이지에서 구독할 수 있습니다.', unconfirmedTiming:'현재 구매 가능 여부는 확인되지 않았습니다. 페이지를 새로고침하거나 웹사이트 또는 확장 프로그램의 계정 페이지에서 구독 상태를 확인하세요.',
    comingSoon:'구매 서비스 준비 중', checking:'구매 가능 여부 확인 대기', noScript:'최신 구매 가능 여부를 확인하려면 JavaScript를 활성화하세요.',
    trial:(d:number,p:number)=>`조건에 맞는 첫 계정은 카드 등록으로 ${d}일 동안 AI 다시 그리기 ${p}페이지를 체험할 수 있습니다. 자격은 구매 시 확인됩니다.`, tax:'세금 및 최종 결제 금액은 결제 화면에 표시됩니다.',
  },
};
export const publishedPricingCopy=(locale:string)=>publishedLabels[locale as keyof typeof publishedLabels]??publishedLabels.en;
