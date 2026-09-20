import type {Locale} from './types';

interface Copy {title:string;description:string;heading:string;body:string;hint:string;home:string;footer:string}
export const paymentSuccess:Record<Locale,Copy> = {
  'zh-CN': {title:'支付成功',description:'已完成 PLUS 开通流程，回到插件继续阅读。',heading:'回到故事里，继续精彩。',body:'感谢你选择 NodeLane PLUS。现在可以切回插件，继续你的漫画旅程。',hint:'会员权益会自动同步。若暂未更新，请在插件「我的账户」中点击刷新。',home:'返回官网',footer:'你可以放心关闭此页面。'},
  'zh-TW': {title:'支付成功',description:'已完成 PLUS 開通流程，回到擴充功能繼續閱讀。',heading:'回到故事裡，繼續精彩。',body:'感謝你選擇 NodeLane PLUS。現在可以切回擴充功能，繼續你的漫畫旅程。',hint:'會員權益會自動同步。若尚未更新，請在擴充功能「我的帳戶」中點擊重新整理。',home:'返回官網',footer:'你可以放心關閉此頁面。'},
  en: {title:'Checkout complete',description:'Your PLUS checkout is complete. Return to the extension to keep reading.',heading:'Your next chapter awaits.',body:'Thank you for choosing NodeLane PLUS. Switch back to the extension and pick up where you left off.',hint:'Your membership updates automatically. If it has not appeared yet, refresh My account in the extension.',home:'Back to home',footer:'You can safely close this page.'},
  ja: {title:'お手続きが完了しました',description:'PLUS のお申し込みが完了しました。拡張機能に戻って読書を続けましょう。',heading:'物語の続きを楽しもう。',body:'NodeLane PLUS をお選びいただきありがとうございます。拡張機能に戻って、漫画の続きをお楽しみください。',hint:'会員情報は自動で更新されます。反映されない場合は、拡張機能の「マイアカウント」で更新してください。',home:'公式サイトに戻る',footer:'このページは閉じても大丈夫です。'},
  ko: {title:'신청이 완료되었습니다',description:'PLUS 신청이 완료되었습니다. 확장 프로그램으로 돌아가 계속 읽어 보세요.',heading:'다음 이야기가 기다려요.',body:'NodeLane PLUS를 선택해 주셔서 감사합니다. 확장 프로그램으로 돌아가 읽던 만화를 계속 즐겨 보세요.',hint:'회원 혜택은 자동으로 동기화됩니다. 아직 반영되지 않았다면 확장 프로그램의 내 계정에서 새로고침해 주세요.',home:'홈페이지로 돌아가기',footer:'이 페이지는 닫아도 괜찮습니다.'},
};
