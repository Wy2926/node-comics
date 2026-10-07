import {uninstall as fr} from './extra/fr';
import {uninstall as es} from './extra/es';
import {uninstall as ptBR} from './extra/pt-BR';
import {uninstall as de} from './extra/de';
import {uninstall as it} from './extra/it';
import {uninstall as ru} from './extra/ru';
import {uninstall as pl} from './extra/pl';
import {uninstall as uk} from './extra/uk';
import {uninstall as tr} from './extra/tr';
import {uninstall as vi} from './extra/vi';
import {uninstall as id} from './extra/id';
import {uninstall as ar} from './extra/ar';
import type {Locale} from './types';

import type {Reason} from './uninstall-reasons';
export {reasonIds, type Reason} from './uninstall-reasons';
export interface UninstallCopy {
  title: string; description: string; reason: string; reasons: Record<Reason, string>;
  comment: string; privacy: string; submit: string; sending: string; retry: string;
  error: string; limited: string; invalid: string; success: string; thanks: string; skip: string; skipped: string; noScript: string;
}
export const uninstallCopy: Record<Locale, UninstallCopy> = {
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

  'zh-CN': {
    title: '感谢你试用 NodeLane 漫译', description: '愿意告诉我们卸载的原因吗？反馈完全自愿，无需登录，也可以直接关闭此页。',
    reason: '主要卸载原因', reasons: {unused: '暂时不需要了', sites: '找不到想看的漫画或不支持常用网站', reading: '导入或阅读不好用', translation: '翻译效果不符合预期', performance: '运行出错、卡顿或占用过高', pricing: '价格或免费额度不合适', privacy: '对权限或隐私有顾虑', other: '其他原因'},
    comment: '补充说明（选填，最多 800 字）', privacy: '仅在点击提交后保存你填写的原因和说明，不关联账号或阅读记录。请勿填写密码、令牌或私密链接。',
    submit: '提交反馈', sending: '正在提交…', retry: '重试确认反馈', error: '暂时无法确认提交结果。内容已保留，点击重试不会重复保存。', limited: '提交过于频繁，请稍后重试。', invalid: '请检查填写内容后重试。',
    success: '反馈已收到', thanks: '感谢你的分享，帮助我们改进阅读体验。现在可以关闭此页。', skip: '跳过反馈', skipped: '无需填写，现在可以关闭此页。', noScript: '请启用 JavaScript 后提交反馈，或直接关闭此页。',
  },
  'zh-TW': {
    title: '感謝你試用 NodeLane 漫譯', description: '願意告訴我們解除安裝的原因嗎？回饋完全自願，無需登入，也可以直接關閉此頁。',
    reason: '主要解除安裝原因', reasons: {unused: '暫時不需要了', sites: '找不到想看的漫畫或不支援常用網站', reading: '匯入或閱讀不好用', translation: '翻譯效果不符合預期', performance: '執行出錯、卡頓或資源占用過高', pricing: '價格或免費額度不合適', privacy: '對權限或隱私有疑慮', other: '其他原因'},
    comment: '補充說明（選填，最多 800 字）', privacy: '僅在點擊提交後儲存你填寫的原因與說明，不連結帳號或閱讀紀錄。請勿填寫密碼、權杖或私人連結。',
    submit: '提交回饋', sending: '正在提交…', retry: '重試確認回饋', error: '暫時無法確認提交結果。內容已保留，重試不會重複儲存。', limited: '提交過於頻繁，請稍後重試。', invalid: '請檢查填寫內容後重試。',
    success: '已收到回饋', thanks: '感謝你的分享，幫助我們改善閱讀體驗。現在可以關閉此頁。', skip: '略過回饋', skipped: '無需填寫，現在可以關閉此頁。', noScript: '請啟用 JavaScript 後提交回饋，或直接關閉此頁。',
  },
  en: {
    title: 'Thanks for trying NodeLane Comics', description: 'Would you like to tell us why you uninstalled? Feedback is optional, requires no sign-in, and you can simply close this page.',
    reason: 'Main reason for uninstalling', reasons: {unused: 'I no longer need it', sites: 'I cannot find comics or my usual sites are unsupported', reading: 'Importing or reading is difficult', translation: 'Translation quality did not meet my expectations', performance: 'Errors, slow performance or high resource usage', pricing: 'Pricing or the free allowance does not suit me', privacy: 'Concerns about permissions or privacy', other: 'Other'},
    comment: 'Anything else? (optional, up to 800 characters)', privacy: 'Your reason and comment are saved only when you submit, without linking your account or reading history. Do not include passwords, tokens or private links.',
    submit: 'Send feedback', sending: 'Sending…', retry: 'Retry to confirm feedback', error: 'We could not confirm receipt. Your text is kept; retrying will not save a duplicate.', limited: 'Too many submissions. Please try again later.', invalid: 'Please check your answers and try again.',
    success: 'Feedback received', thanks: 'Thank you for helping us improve the reading experience. You can now close this page.', skip: 'Skip feedback', skipped: 'No feedback needed. You can now close this page.', noScript: 'Enable JavaScript to send feedback, or simply close this page.',
  },
  ja: {
    title: 'NodeLane Comics をお試しいただきありがとうございます', description: 'アンインストールした理由を教えていただけますか？回答は任意で、ログインも不要です。そのままページを閉じてもかまいません。',
    reason: 'アンインストールの主な理由', reasons: {unused: '今は必要なくなった', sites: '読みたい漫画が見つからない・利用サイトが未対応', reading: '取り込みや閲覧が使いにくい', translation: '翻訳の品質が期待に届かなかった', performance: 'エラー・動作の遅さ・リソース消費が気になる', pricing: '料金や無料枠が合わない', privacy: '権限やプライバシーが気になる', other: 'その他'},
    comment: '補足（任意・800 文字まで）', privacy: '送信した理由と補足のみを保存し、アカウントや読書履歴とは関連付けません。パスワード、トークン、非公開リンクは記載しないでください。',
    submit: 'フィードバックを送信', sending: '送信中…', retry: '再試行して受付を確認', error: '受付を確認できませんでした。内容は保持されています。再試行しても重複して保存されません。', limited: '送信回数が多すぎます。しばらくしてから再試行してください。', invalid: '入力内容を確認して再試行してください。',
    success: 'フィードバックを受け付けました', thanks: '読書体験の改善にご協力いただきありがとうございます。このページを閉じてかまいません。', skip: '回答をスキップ', skipped: '回答は不要です。このページを閉じてかまいません。', noScript: '送信するには JavaScript を有効にするか、そのままページを閉じてください。',
  },
  ko: {
    title: 'NodeLane Comics를 사용해 주셔서 감사합니다', description: '삭제한 이유를 알려주시겠어요? 의견 제출은 선택 사항이며 로그인이 필요 없습니다. 이 페이지를 바로 닫아도 됩니다.',
    reason: '삭제한 주된 이유', reasons: {unused: '더 이상 필요하지 않음', sites: '원하는 만화를 찾을 수 없거나 자주 쓰는 사이트 미지원', reading: '가져오기나 읽기가 불편함', translation: '번역 품질이 기대에 미치지 못함', performance: '오류, 느린 동작 또는 높은 자원 사용량', pricing: '가격이나 무료 제공량이 맞지 않음', privacy: '권한이나 개인정보 보호가 걱정됨', other: '기타'},
    comment: '추가 의견 (선택, 최대 800자)', privacy: '제출할 때만 이유와 의견을 저장하며 계정이나 읽기 기록과 연결하지 않습니다. 비밀번호, 토큰 또는 비공개 링크를 입력하지 마세요.',
    submit: '의견 보내기', sending: '보내는 중…', retry: '다시 시도하여 접수 확인', error: '접수 여부를 확인하지 못했습니다. 내용은 유지되며 다시 시도해도 중복 저장되지 않습니다.', limited: '제출 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.', invalid: '입력 내용을 확인하고 다시 시도하세요.',
    success: '의견을 받았습니다', thanks: '읽기 환경 개선에 도움을 주셔서 감사합니다. 이제 이 페이지를 닫아도 됩니다.', skip: '건너뛰기', skipped: '의견을 작성하지 않아도 됩니다. 이제 이 페이지를 닫아도 됩니다.', noScript: '의견을 보내려면 JavaScript를 활성화하거나 이 페이지를 닫으세요.',
  },
};
