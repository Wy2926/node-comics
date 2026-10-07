import { commerceCopy, formatCopy } from '../i18n/commerce';

interface ComparisonRow {label:string;free:string;lite:string}
export interface PricingComparisonCopy {
  feature:string;highlights:string;
  reading:ComparisonRow;classic:ComparisonRow;model:ComparisonRow;
  rate:Omit<ComparisonRow,'lite'>&{lite:(hourly:number)=>string};
  priority:ComparisonRow;early:ComparisonRow;note:string;
}
const labels:Record<string,PricingComparisonCopy>={
  'zh-CN':{
    feature:'功能与权益',highlights:'Lite 翻译权益',
    model:{label:'翻译模型',free:'GPT 6 Luna 等系列',lite:'Gemini 3.8 Flash 等系列'},
    reading:{label:'阅读功能',free:'全部基础阅读功能',lite:'全部基础阅读功能'},
    classic:{label:'常规翻译',free:'30 页 / 天',lite:'不设日／月累计上限'},
    rate:{label:'新翻译受理限额',free:'10 页 / 滚动分钟',lite:n=>`100 页 / 滚动分钟；${n.toLocaleString('zh-CN')} 页 / 滚动小时`},
    priority:{label:'翻译任务响应',free:'标准调度',lite:'优先响应'},
    early:{label:'新功能体验',free:'随正式版本开放',lite:'高级功能优先体验'},
    note:'限额按同一账户跨设备、模式与语言共享的滚动窗口计算；重复请求与已完成结果复用不重复计数。受理限额和优先调度不承诺完成速度或固定份额。新功能以发布说明为准。',
  },
  'zh-TW':{
    feature:'功能與權益',highlights:'Lite 翻譯權益',
    model:{label:'翻譯模型',free:'GPT 6 Luna 等系列',lite:'Gemini 3.8 Flash 等系列'},
    reading:{label:'閱讀功能',free:'全部基本閱讀功能',lite:'全部基本閱讀功能'},
    classic:{label:'一般翻譯',free:'30 頁 / 天',lite:'不設日／月累計上限'},
    rate:{label:'新翻譯受理上限',free:'10 頁 / 滾動分鐘',lite:n=>`100 頁 / 滾動分鐘；${n.toLocaleString('zh-TW')} 頁 / 滾動小時`},
    priority:{label:'翻譯任務回應',free:'標準排程',lite:'優先回應'},
    early:{label:'新功能體驗',free:'隨正式版本開放',lite:'進階功能優先體驗'},
    note:'上限按同一帳戶跨裝置、模式與語言共用的滾動窗口計算；重複請求與已完成結果重用不重複計數。受理上限和優先排程不保證完成速度或固定份額。新功能以版本說明為準。',
  },
  en:{
    feature:'Features and benefits',highlights:'TRANSLATE WITH Lite',
    model:{label:'Translation models',free:'GPT 6 Luna and similar models',lite:'Gemini 3.8 Flash and similar models'},
    reading:{label:'Reading',free:'All core reading features',lite:'All core reading features'},
    classic:{label:'Classic translation',free:'30 pages / day',lite:'No daily or monthly total cap'},
    rate:{label:'New translation request limit',free:'10 pages / rolling minute',lite:n=>`100 pages / rolling minute; ${n.toLocaleString('en')} pages / rolling hour`},
    priority:{label:'Translation task response',free:'Standard scheduling',lite:'Priority response'},
    early:{label:'New features',free:'At general release',lite:'Early access to advanced features'},
    note:'Rolling windows are shared across devices, modes and languages on one account. Duplicate requests and reuse of completed results are not counted again. Request limits and priority scheduling do not guarantee completion speed or a fixed share of capacity. See release notes for new features.',
  },
  ja:{
    feature:'機能と特典',highlights:'Lite の翻訳特典',
    model:{label:'翻訳モデル',free:'GPT 6 Luna などのモデル',lite:'Gemini 3.8 Flash などのモデル'},
    reading:{label:'読書機能',free:'すべての基本読書機能',lite:'すべての基本読書機能'},
    classic:{label:'通常翻訳',free:'30 ページ / 日',lite:'日・月の累計上限なし'},
    rate:{label:'新規翻訳の受付上限',free:'直近1分で10ページ',lite:n=>`直近1分で100ページ、直近1時間で${n.toLocaleString('ja')}ページ`},
    priority:{label:'翻訳タスク応答',free:'通常のスケジューリング',lite:'優先応答'},
    early:{label:'新機能の利用',free:'正式公開時に利用可能',lite:'高度な機能を先行体験'},
    note:'直近の受付数は同一アカウントの全端末・モード・言語で共有されます。同じリクエストや完了結果の再利用は重複集計しません。受付上限と優先処理は完了速度や固定の処理枠を保証しません。新機能はリリースノートをご確認ください。',
  },
  ko:{
    feature:'기능과 혜택',highlights:'Lite 번역 혜택',
    model:{label:'번역 모델',free:'GPT 6 Luna 등 모델',lite:'Gemini 3.8 Flash 등 모델'},
    reading:{label:'읽기 기능',free:'모든 기본 읽기 기능',lite:'모든 기본 읽기 기능'},
    classic:{label:'일반 번역',free:'30페이지 / 일',lite:'일일·월간 총 페이지 제한 없음'},
    rate:{label:'새 번역 요청 한도',free:'최근 1분 동안 10페이지',lite:n=>`최근 1분 동안 100페이지, 최근 1시간 동안 ${n.toLocaleString('ko')}페이지`},
    priority:{label:'번역 작업 응답',free:'일반 작업 배정',lite:'우선 응답'},
    early:{label:'새 기능 체험',free:'정식 출시 후 이용',lite:'고급 기능 우선 체험'},
    note:'한도는 같은 계정의 모든 기기·모드·언어에서 최근 시간 기준으로 공유됩니다. 중복 요청과 완료된 결과의 재사용은 다시 계산하지 않습니다. 요청 한도와 우선 배정은 완료 속도나 고정 처리 비율을 보장하지 않습니다. 새 기능은 릴리스 노트를 확인하세요.',
  },
};
export function comparisonCopy(locale:string):PricingComparisonCopy {
 const copy=commerceCopy(locale)?.comparison;
 return copy ? {...copy,rate:{...copy.rate,lite:(n:number)=>formatCopy(copy.rate.lite,{n:n.toLocaleString(locale)})}} : labels[locale]??labels.en;
}
export function comparisonRows(locale:string,hourly:number){
 const copy=comparisonCopy(locale);
 return (['classic','model','rate','priority','reading','early'] as const).map(key=>{
   const row=copy[key],lite=typeof row.lite==='function'?row.lite(hourly):row.lite;
   return {key,label:row.label,free:row.free,lite,shared:row.free===lite};
 });
}
