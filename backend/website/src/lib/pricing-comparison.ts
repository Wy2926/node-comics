interface ComparisonRow {
  label: string;
  free: string;
  plus: string;
}

export interface PricingComparisonCopy {
  feature: string;
  highlights: string;
  reading: ComparisonRow;
  classic: ComparisonRow;
  rate: ComparisonRow;
  redraw: Omit<ComparisonRow, 'plus'> & {plus: (pages: number) => string};
  priority: ComparisonRow;
  early: ComparisonRow;
  note: string;
}

const labels: Record<string, PricingComparisonCopy> = {
  'zh-CN': {
    feature: '功能与权益',
    highlights: 'PLUS 升级权益',
    reading: {label: '阅读功能', free: '全部基础阅读功能', plus: '全部基础阅读功能'},
    classic: {label: '常规翻译', free: '30 页 / 天', plus: '不限页数'},
    rate: {label: '翻译速率', free: '标准请求速率', plus: '更高请求速率'},
    redraw: {label: 'AI 重绘', free: '仅限有效赠送额度', plus: pages => `${pages.toLocaleString('zh-CN')} 页 / 月`},
    priority: {label: '翻译任务响应', free: '标准调度', plus: '优先响应'},
    early: {label: '新功能体验', free: '随正式版本开放', plus: '高级功能优先体验'},
    note: '速率按跨设备共享的滚动 60 秒计算，以账户实际限额为准；优先响应表示调度时优先考虑 PLUS 任务，不承诺固定份额或完成时长。新功能陆续开放，以发布说明为准。',
  },
  'zh-TW': {
    feature: '功能與權益',
    highlights: 'PLUS 升級權益',
    reading: {label: '閱讀功能', free: '全部基本閱讀功能', plus: '全部基本閱讀功能'},
    classic: {label: '一般翻譯', free: '30 頁 / 天', plus: '不限頁數'},
    rate: {label: '翻譯速率', free: '標準請求速率', plus: '更高請求速率'},
    redraw: {label: 'AI 重繪', free: '僅限有效贈送額度', plus: pages => `${pages.toLocaleString('zh-TW')} 頁 / 月`},
    priority: {label: '翻譯任務回應', free: '標準排程', plus: '優先回應'},
    early: {label: '新功能體驗', free: '隨正式版本開放', plus: '進階功能優先體驗'},
    note: '速率按跨裝置共用的滾動 60 秒計算，以帳戶實際限額為準；優先回應表示排程時優先考慮 PLUS 任務，不保證固定份額或完成時間。新功能陸續開放，以版本說明為準。',
  },
  en: {
    feature: 'Features and benefits',
    highlights: 'MORE WITH PLUS',
    reading: {label: 'Reading', free: 'All core reading features', plus: 'All core reading features'},
    classic: {label: 'Classic translation', free: '30 pages / day', plus: 'Unlimited pages'},
    rate: {label: 'Translation rate', free: 'Standard request rate', plus: 'Higher request rate'},
    redraw: {label: 'AI redraw', free: 'With active bonus pages', plus: pages => `${pages.toLocaleString('en')} pages / month`},
    priority: {label: 'Translation task response', free: 'Standard scheduling', plus: 'Priority response'},
    early: {label: 'New features', free: 'At general release', plus: 'Early access to advanced features'},
    note: 'Rates use rolling 60-second windows shared across devices, with limits shown in your account; priority gives eligible PLUS tasks preference, without guaranteeing a fixed share or completion time. New features roll out gradually; see release notes.',
  },
  ja: {
    feature: '機能と特典',
    highlights: 'PLUS の特典',
    reading: {label: '読書機能', free: 'すべての基本読書機能', plus: 'すべての基本読書機能'},
    classic: {label: '通常翻訳', free: '30 ページ / 日', plus: 'ページ数無制限'},
    rate: {label: '翻訳レート', free: '標準リクエストレート', plus: 'より高いリクエストレート'},
    redraw: {label: 'AI 再描画', free: '有効な特典枠のみ', plus: pages => `${pages.toLocaleString('ja')} ページ / 月`},
    priority: {label: '翻訳タスク応答', free: '通常のスケジューリング', plus: '優先応答'},
    early: {label: '新機能の利用', free: '正式公開時に利用可能', plus: '高度な機能を先行体験'},
    note: 'レートは全端末で共有する直近 60 秒間で集計され、実際の上限はアカウントに表示されます。優先応答では PLUS のタスクを優先的に考慮しますが、固定の割り当て比率や完了時間は保証しません。新機能は順次公開され、詳細はリリースノートでご案内します。',
  },
  ko: {
    feature: '기능과 혜택',
    highlights: 'PLUS 업그레이드 혜택',
    reading: {label: '읽기 기능', free: '모든 기본 읽기 기능', plus: '모든 기본 읽기 기능'},
    classic: {label: '일반 번역', free: '30페이지 / 일', plus: '페이지 수 무제한'},
    rate: {label: '번역 요청 한도', free: '기본 요청 한도', plus: '더 높은 요청 한도'},
    redraw: {label: 'AI 다시 그리기', free: '유효한 증정 한도만', plus: pages => `${pages.toLocaleString('ko')}페이지 / 월`},
    priority: {label: '번역 작업 응답', free: '일반 작업 배정', plus: '우선 응답'},
    early: {label: '새 기능 체험', free: '정식 출시 후 이용', plus: '고급 기능 우선 체험'},
    note: '한도는 기기 간 공유되는 최근 60초 기준이며 계정에서 확인할 수 있고, 우선 응답은 PLUS 작업을 우선적으로 고려하되 고정 배정 비율이나 완료 시간을 보장하지 않습니다. 새 기능은 릴리스 노트에 따라 순차 공개됩니다.',
  },
};

export const comparisonCopy = (locale: string): PricingComparisonCopy => labels[locale] ?? labels.en;
