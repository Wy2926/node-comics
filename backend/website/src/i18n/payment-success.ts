import {paymentSuccess as fr} from './extra/fr';
import {paymentSuccess as es} from './extra/es';
import {paymentSuccess as ptBR} from './extra/pt-BR';
import {paymentSuccess as de} from './extra/de';
import {paymentSuccess as it} from './extra/it';
import {paymentSuccess as ru} from './extra/ru';
import {paymentSuccess as pl} from './extra/pl';
import {paymentSuccess as uk} from './extra/uk';
import {paymentSuccess as tr} from './extra/tr';
import {paymentSuccess as vi} from './extra/vi';
import {paymentSuccess as id} from './extra/id';
import {paymentSuccess as ar} from './extra/ar';
import type {Locale} from './types';

interface Copy {title:string;heading:string;body:string;hint:string;home:string;footer:string}
export const paymentSuccess:Record<Locale,Copy> = {
  'fr':fr,
  'es':es,
  'pt-BR':ptBR,
  'de':de,
  'it':it,
  'ru':ru,
  'pl':pl,
  'uk':uk,
  'tr':tr,
  'vi':vi,
  'id':id,'ar':ar,

  'zh-CN': {title:'支付成功',heading:'回到故事里，继续精彩。',body:'感谢你选择 NodeLane Comics。现在可以切回插件，继续你的漫画旅程。',hint:'付款核实后，订阅权益或购买额度会同步到账户。请在账户中刷新核实。',home:'返回官网',footer:'你可以放心关闭此页面。'},
  'zh-TW': {title:'支付成功',heading:'回到故事裡，繼續精彩。',body:'感謝你選擇 NodeLane Comics。現在可以切回擴充功能，繼續你的漫畫旅程。',hint:'付款確認後，訂閱權益或購買額度會同步至帳戶。請在帳戶中重新整理確認。',home:'返回官網',footer:'你可以放心關閉此頁面。'},
  en: {title:'Checkout complete',heading:'Your next chapter awaits.',body:'Thank you for choosing NodeLane Comics. Switch back to the extension and pick up where you left off.',hint:'Subscription benefits or purchased pages appear after payment is verified. Refresh your account to check.',home:'Back to home',footer:'You can safely close this page.'},
  ja: {title:'お手続きが完了しました',heading:'物語の続きを楽しもう。',body:'NodeLane Comics をお選びいただきありがとうございます。拡張機能に戻って、漫画の続きをお楽しみください。',hint:'支払い確認後、購読特典または購入ページがアカウントに反映されます。更新してご確認ください。',home:'公式サイトに戻る',footer:'このページは閉じても大丈夫です。'},
  ko: {title:'신청이 완료되었습니다',heading:'다음 이야기가 기다려요.',body:'NodeLane Comics를 선택해 주셔서 감사합니다. 확장 프로그램으로 돌아가 읽던 만화를 계속 즐겨 보세요.',hint:'결제가 확인되면 구독 혜택 또는 구매 페이지가 계정에 반영됩니다. 계정을 새로고침해 확인하세요.',home:'홈페이지로 돌아가기',footer:'이 페이지는 닫아도 괜찮습니다.'},
};
