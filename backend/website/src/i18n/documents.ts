import type { Locale } from './locales';

const en = {
  lang: 'en', navImage: 'Images', navDocument: 'PDF / ZIP files', title: 'Translate a whole file',
  intro: 'Upload a PDF or an image ZIP / CBZ. We translate every page in the background and deliver one complete translated-image ZIP, including for PDF inputs.',
  limits: 'Up to 200 MB (200,000,000 bytes) and 200 pages. No password-protected files. Page count is checked on the server.',
  quotaRule: 'Pages are reserved together before translation. You can cancel only before this reservation; once reserved, the task cannot be cancelled. If quota is insufficient, add quota then choose Continue yourself.',
  privacy: 'The file uploads directly to object storage. Keep this page open until upload confirmation; after that, you can leave and return to the server-side history.',
  login: 'Sign in to upload', paid: 'Available with a paid subscription or available purchased quota. Trials and gifted quota alone do not unlock file translation.',
  pricing: 'Plans & quota', disabled: 'File translation is not available yet.', noModels: 'No document-capable model is currently available for this account.',
  choose: 'Choose PDF, ZIP or CBZ', language: 'Translate into', model: 'Document model', upload: 'Upload & translate', retryUpload: 'Retry upload',
  hashing: 'Checking file', uploading: 'Uploading to storage', sealing: 'Confirming upload', confirmed: 'Upload confirmed. You can leave this page; translation continues in the background.',
  notConfirmed: 'Upload was not confirmed. Check this task in history before retrying; interrupted uploads expire automatically.',
  history: 'File history', historyHint: 'Saved on the server for this account. Files and results are available only until their expiry.',
  empty: 'No file tasks yet.', refresh: 'Refresh', older: 'Older tasks', latest: 'Latest tasks', loading: 'Loading…',
  cancel: 'Cancel', resume: 'Continue after adding quota', download: 'Download translated ZIP', expiry: 'Available until',
  pages: '{count} pages', pageProgress: '{done}/{total} pages', used: '{count} pages charged', reserved: '{count} pages reserved', released: '{count} pages released',
  shortage: 'Need {needed} pages · available {available} · short by {difference}',
  manualResume: 'Adding quota does not restart this task automatically. Continue before the expiry, or cancel.',
  unknown: 'The model response is being checked. This task will not send another automatic model request.',
  expired: 'This file has expired.', output: 'Complete translated-image ZIP',
  statuses: { uploading: 'Waiting for upload', preflight: 'Checking file & counting pages', awaiting_quota: 'Waiting for quota', queued: 'Queued', running: 'Processing', outcome_unknown: 'Checking model response', succeeded: 'Ready', failed: 'Failed', cancelled: 'Cancelled' } as Record<string, string>,
  phases: { doc_prepare: 'Checking file & counting pages', doc_ocr: 'Recognizing pages', doc_text: 'Translating the whole document', doc_render: 'Rendering translated pages', doc_zip: 'Packaging translated ZIP' } as Record<string, string>,
  errors: {
    generic: 'The request could not be completed. Refresh the task status and try again.', auth: 'Your account changed or sign-in expired. Sign in again.',
    file: 'Choose a valid PDF, ZIP or CBZ file up to 200 MB.', page: 'The file exceeds the 200-page limit or the safe size of a page.',
    format: 'The file could not be opened. Check its format, images and archive entries, and remove password protection.',
    cancelled: 'The task has reserved its pages and can no longer be cancelled.', context: 'This document contains too much text for the selected model. Use a smaller document.',
    storage: 'Storage is temporarily unavailable. Your task is preserved; check its status before retrying.', quota: 'Not enough eligible page quota. Add quota, then choose Continue.',
    model: 'This model cannot accept this document. Refresh the available models.', expired: 'The upload or result has expired. Start a new file task.',
    rate: 'Too many requests. Please wait and try again.', hash: 'Could not read the selected file. Select it again and retry.',
  },
};

export type DocumentCopy = typeof en;
const zhCN: DocumentCopy = {
  lang: 'zh-CN', navImage: '单张图片', navDocument: 'PDF / 压缩包', title: '整份文件翻译',
  intro: '上传 PDF 或图片 ZIP / CBZ，后台逐页处理，完成后下载一个完整译图 ZIP。PDF 输入也输出译图 ZIP。',
  limits: '每份最多 200 MB（200,000,000 字节）、200 页，不支持加密文件。页数由服务器校验。',
  quotaRule: '翻译前一次预占整份页数。仅预占前可取消，预占后不可取消；额度不足时先补充额度，再手动点击继续。',
  privacy: '文件直传对象存储。请等待上传确认后再离开，后台会继续处理，任务历史保存在当前账户。',
  login: '登录后上传', paid: '仅有效付费订阅或有可用购买额度的用户可用。试用和赠送额度本身不解锁文件翻译。',
  pricing: '套餐与额度', disabled: '文件翻译暂未开放。', noModels: '当前账户暂无可用的整份文件翻译模型。',
  choose: '选择 PDF、ZIP 或 CBZ', language: '翻译为', model: '文件翻译模型', upload: '上传并翻译', retryUpload: '重试上传',
  hashing: '校验文件', uploading: '直传文件', sealing: '确认上传', confirmed: '上传已确认，可以离开此页面。后台会继续翻译，可稍后从历史下载。',
  notConfirmed: '尚未确认上传成功。请先查看任务历史再重试，中断的上传会自动过期。',
  history: '文件任务历史', historyHint: '记录保存在当前账户的服务器历史中。文件和结果仅在有效期内保留。',
  empty: '还没有文件任务。', refresh: '刷新', older: '更早的任务', latest: '最新任务', loading: '加载中…',
  cancel: '取消', resume: '补充额度后继续', download: '下载译图 ZIP', expiry: '有效期至',
  pages: '{count} 页', pageProgress: '{done}/{total} 页', used: '已扣 {count} 页', reserved: '预占 {count} 页', released: '已释放 {count} 页',
  shortage: '需要 {needed} 页 · 当前可用 {available} 页 · 还差 {difference} 页',
  manualResume: '补充额度后不会自动启动。请在有效期内点击继续，也可以取消。',
  unknown: '正在核实模型响应，此任务不会自动再次提交模型请求。', expired: '此文件已过期。', output: '完整译图 ZIP',
  statuses: { uploading: '等待上传', preflight: '校验文件与页数', awaiting_quota: '等待补充额度', queued: '排队中', running: '处理中', outcome_unknown: '核实模型响应', succeeded: '可下载', failed: '失败', cancelled: '已取消' },
  phases: { doc_prepare: '校验文件与页数', doc_ocr: '识别各页文字', doc_text: '整份汇总翻译', doc_render: '生成译图', doc_zip: '打包译图 ZIP' },
  errors: { generic: '操作未完成，请刷新任务状态后重试。', auth: '账户已变更或登录已过期，请重新登录。',
    file: '请选择有效的 PDF、ZIP 或 CBZ，文件不得超过 200 MB。', page: '文件超过 200 页，或单页超出安全尺寸限制。',
    format: '无法读取文件，请检查格式、图片和压缩包条目，并移除密码保护。', cancelled: '任务已完成页数预占，不能再取消。',
    context: '这份文件的文字量超过所选模型的容量，请缩小文件后重试。', storage: '存储暂时不可用，任务已保留，请先查看状态再重试。',
    quota: '可用的模型匹配页数不足，请补充额度后点击继续。', model: '此模型无法接收该文件，请刷新可用模型列表。',
    expired: '上传或结果已过期，请创建新的文件任务。', rate: '请求过于频繁，请稍后重试。', hash: '无法读取所选文件，请重新选择后重试。' },
};
const zhTW: DocumentCopy = {
  lang: 'zh-TW', navImage: '單張圖片', navDocument: 'PDF / 壓縮檔', title: '整份檔案翻譯',
  intro: '上傳 PDF 或圖片 ZIP / CBZ，由背景逐頁處理，完成後下載一個完整譯圖 ZIP。PDF 輸入也輸出譯圖 ZIP。',
  limits: '每份最多 200 MB（200,000,000 位元組）、200 頁，不支援加密檔案。頁數由伺服器驗證。',
  quotaRule: '翻譯前一次預留整份頁數。僅預留前可取消，預留後不可取消；額度不足時先補充額度，再手動點選繼續。',
  privacy: '檔案直接上傳物件儲存。請等待上傳確認後再離開，背景會繼續處理，任務記錄保存在目前帳戶。',
  login: '登入後上傳', paid: '僅有效付費訂閱或有可用購買額度的使用者可用。試用和贈送額度本身不解鎖檔案翻譯。',
  pricing: '方案與額度', disabled: '檔案翻譯尚未開放。', noModels: '目前帳戶暫無可用的整份檔案翻譯模型。',
  choose: '選擇 PDF、ZIP 或 CBZ', language: '翻譯為', model: '檔案翻譯模型', upload: '上傳並翻譯', retryUpload: '重試上傳',
  hashing: '驗證檔案', uploading: '直接上傳檔案', sealing: '確認上傳', confirmed: '上傳已確認，可以離開此頁面。背景會繼續翻譯，可稍後從記錄下載。',
  notConfirmed: '尚未確認上傳成功。請先查看任務記錄再重試，中斷的上傳會自動到期。',
  history: '檔案任務記錄', historyHint: '記錄保存在目前帳戶的伺服器記錄中。檔案與結果僅在有效期內保留。',
  empty: '還沒有檔案任務。', refresh: '重新整理', older: '更早的任務', latest: '最新任務', loading: '載入中…',
  cancel: '取消', resume: '補充額度後繼續', download: '下載譯圖 ZIP', expiry: '有效期至',
  pages: '{count} 頁', pageProgress: '{done}/{total} 頁', used: '已扣 {count} 頁', reserved: '預留 {count} 頁', released: '已釋放 {count} 頁',
  shortage: '需要 {needed} 頁 · 目前可用 {available} 頁 · 還差 {difference} 頁',
  manualResume: '補充額度後不會自動啟動。請在有效期內點選繼續，也可以取消。',
  unknown: '正在核實模型回應，此任務不會自動再次提交模型請求。', expired: '此檔案已到期。', output: '完整譯圖 ZIP',
  statuses: { uploading: '等待上傳', preflight: '驗證檔案與頁數', awaiting_quota: '等待補充額度', queued: '排隊中', running: '處理中', outcome_unknown: '核實模型回應', succeeded: '可下載', failed: '失敗', cancelled: '已取消' },
  phases: { doc_prepare: '驗證檔案與頁數', doc_ocr: '辨識各頁文字', doc_text: '整份彙整翻譯', doc_render: '產生譯圖', doc_zip: '打包譯圖 ZIP' },
  errors: { generic: '操作未完成，請重新整理任務狀態後重試。', auth: '帳戶已變更或登入已過期，請重新登入。',
    file: '請選擇有效的 PDF、ZIP 或 CBZ，檔案不得超過 200 MB。', page: '檔案超過 200 頁，或單頁超出安全尺寸限制。',
    format: '無法讀取檔案，請檢查格式、圖片和壓縮檔項目，並移除密碼保護。', cancelled: '任務已完成頁數預留，不能再取消。',
    context: '這份檔案的文字量超過所選模型的容量，請縮小檔案後重試。', storage: '儲存暫時無法使用，任務已保留，請先查看狀態再重試。',
    quota: '可用且符合模型的頁數不足，請補充額度後點選繼續。', model: '此模型無法接收該檔案，請重新整理可用模型清單。',
    expired: '上傳或結果已到期，請建立新的檔案任務。', rate: '請求過於頻繁，請稍後重試。', hash: '無法讀取所選檔案，請重新選擇後重試。' },
};

// Explicit English fallback for the remaining site locales; the section sets lang=en.
export function documentCopy(locale: Locale): DocumentCopy { return locale === 'zh-CN' ? zhCN : locale === 'zh-TW' ? zhTW : en; }
export function documentFormat(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (token, key) => String(values[key] ?? token));
}
export function documentError(code: string, t: DocumentCopy): string {
  if (code === 'AUTH_REQUIRED') return t.errors.auth;
  if (code === 'DOCUMENT_PAID_REQUIRED') return t.paid;
  if (code === 'DOCUMENT_DISABLED') return t.disabled;
  if (code === 'DOCUMENT_NOT_CANCELLABLE') return t.errors.cancelled;
  if (code === 'DOCUMENT_QUOTA_INSUFFICIENT') return t.errors.quota;
  if (/MODEL.*(UNSUPPORTED|UNAVAILABLE|INVALID|NOT_ALLOWED)/.test(code)) return t.errors.model;
  if (/CONTEXT_EXCEEDED/.test(code)) return t.errors.context;
  if (/EXPIRED|UPLOAD_CLOSED|RESULT_UNAVAILABLE/.test(code)) return t.errors.expired;
  if (/PAGE_LIMIT|PAGE_TOO_LARGE/.test(code)) return t.errors.page;
  if (/SOURCE_TOO_LARGE|UNSUPPORTED_FORMAT/.test(code)) return t.errors.file;
  if (/HASH_FAILED/.test(code)) return t.errors.hash;
  if (/RATE|CONCURRENCY|TOO_MANY/.test(code)) return t.errors.rate;
  if (/STORAGE|UPLOAD_FAILED|UPLOAD_INCOMPLETE/.test(code)) return t.errors.storage;
  if (/INVALID_(FILE|ARCHIVE|PDF|PAGE)|ENCRYPTED|UNSAFE_ARCHIVE|UNSUPPORTED_(ENTRY|COMPRESSION)|FORMAT_MISMATCH|NO_IMAGES|ANIMATED_IMAGE|ARCHIVE_BUDGET/.test(code)) return t.errors.format;
  return t.errors.generic;
}
