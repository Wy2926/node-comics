export const numericFields = [
  {key: 'free_daily_pages', group: 'entitlements', title: '普通用户每日常规页数', unit: '页 / 天', min: 0, max: 1000000, integer: true,
    help: '仅新建的每日额度周期采用新值，已生效周期的已用、预占和总额保持不变。'},
  {key: 'guest_daily_limit', group: 'guest', title: '每位匿名访客每日受理上限', unit: '张 / 天', min: 1, max: 100, integer: true,
    help: '同一游客身份的新受理常规翻译张数；已受理任务失败、取消、无字或部分完成仍计次。'},
  {key: 'guest_network_daily_limit', group: 'guest', title: '同一网络每日匿名受理上限', unit: '张 / 天', min: 1, max: 1000, integer: true,
    help: '同一 IPv4 地址或 IPv6 /64 前缀共享预算；更换游客 Cookie 不重置网络已用次数。'},
  {key: 'guest_global_daily_limit', group: 'guest', title: '全站每日匿名受理上限', unit: '张 / 天', min: 1, max: 100000, integer: true,
    help: '全站匿名访客合计的新受理张数；修改限额不清零已用次数，也不取消已受理任务。'},
  {key: 'free_images_per_minute', group: 'translation', title: '普通用户新翻译图片', unit: '张 / 60 秒', min: 1, max: 10000, integer: true,
    help: '同一账户在任意滚动 60 秒内受理的新翻译图片数。重复请求、重传和完成结果复用不计数。'},
  {key: 'plus_images_per_minute', group: 'translation', title: 'PLUS 新翻译图片', unit: '张 / 60 秒', min: 1, max: 10000, integer: true,
    help: '已有原图但需要新的翻译也计数；取消或失败不返还已消耗的分钟名额。'},
  {key: 'upload_user_concurrency', group: 'upload', title: '单用户同时上传数', unit: '个', min: 1, max: 32, integer: true,
    help: '每位用户最多同时进行的图片上传。'},
  {key: 'upload_global_concurrency', group: 'upload', title: '全站同时上传数', unit: '个', min: 1, max: 128, integer: true,
    help: '全站同时进行的图片上传总上限，应不小于单用户上限。'},
  {key: 'upload_idle_timeout_seconds', group: 'upload', title: '上传空闲超时', unit: '秒', min: 0.1, max: 120, integer: false,
    help: '连续未收到图片数据超过此时间，结束本次上传。'},
  {key: 'upload_body_timeout_seconds', group: 'upload', title: '单次上传最长时间', unit: '秒', min: 0.1, max: 900, integer: false,
    help: '接收一张图片的总时限，应不小于空闲超时。'},
  {key: 'upload_ingress_lease_seconds', group: 'upload', title: '上传占位有效期', unit: '秒', min: 15, max: 300, integer: true,
    help: '正常上传会续期；处理进程中断后，占位到期可重新使用。'},
  {key: 'feedback_requests_per_minute', group: 'feedback', title: '每用户反馈持续速率', unit: '条 / 分钟', min: 1, max: 1000, integer: true,
    help: '限制持续新增反馈的速度；发送机会按此速率恢复。'},
  {key: 'feedback_request_burst', group: 'feedback', title: '每用户反馈突发上限', unit: '条', min: 1, max: 100, integer: true,
    help: '每位用户短时间内可连续提交的新反馈数量。'},
  {key: 'feedback_receipts_per_day', group: 'feedback', title: '每用户每日新反馈上限', unit: '条 / 天', min: 1, max: 10000, integer: true,
    help: '按 UTC 自然日计算。重试已提交的同一条反馈不重复计数。'},
] as const;

export const promptFields = [
  {key: 'comic_translation_prompt', title: '漫画正文翻译提示词',
    help: '单页和整本共用。描述如何保留专有名称、人物语气、梗、双关与言外之意；只使用请求中实际提供的上下文，不补写剧情。',
    effect: '仅影响保存后新受理的翻译；已受理任务和自动重试继续使用受理时冻结的提示词。'},
  {key: 'comic_title_prompt', title: '漫画名称翻译提示词',
    help: '用于跨语言搜索。优先可靠的通行作品名；没有可靠依据时保留专名，不编造官方译名。',
    effect: '仅影响后续缓存未命中的名称翻译；已有名称缓存不会被删除。'},
] as const;
export const promptMaxLength = 8000;
type NumericKey = typeof numericFields[number]['key'];
export type PromptKey = typeof promptFields[number]['key'];
type SettingKey = NumericKey | PromptKey;
export type Values = Record<NumericKey, number> & Record<PromptKey, string>;
export type Draft = Record<SettingKey, string>;
export type Snapshot = {version: number; values: Values; prompt_defaults: Record<PromptKey, string>;
  updated_at: string | null; updated_by: string | null};
type FieldErrors = Partial<Record<SettingKey, string>>;
export const settingKeys: SettingKey[] = [...numericFields.map(field => field.key), ...promptFields.map(field => field.key)];
// Match Python str.strip() for the whitespace still allowed after control-character validation.
export const normalizePrompt = (value: string) => value.replace(/\r\n?/g, '\n')
  .replace(/^[\t\n \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
export const promptLength = (value: string) => Array.from(normalizePrompt(value)).length;
export const toDraft = (values: Values) => Object.fromEntries(settingKeys.map(key => [key, String(values[key])])) as Draft;
export const changed = (draft: Draft, values: Values, key: SettingKey) => typeof values[key] === 'number'
  ? draft[key].trim() === '' || Number(draft[key]) !== values[key]
  : normalizePrompt(draft[key]) !== values[key];

export function mergeDraft(values: Values, previous?: {values: Values; draft: Draft}) {
  const draft = toDraft(values);
  let preserved = false;
  if (previous) for (const key of settingKeys) {
    if (changed(previous.draft, previous.values, key)) {
      draft[key] = previous.draft[key]; preserved = true;
    }
  }
  return {draft, preserved};
}

export function validate(draft: Draft) {
  const errors: FieldErrors = {};
  const values = {} as Values;
  for (const field of numericFields) {
    const value = Number(draft[field.key]);
    if (!draft[field.key].trim() || !Number.isFinite(value) || value < field.min || value > field.max ||
        (field.integer && !Number.isInteger(value))) {
      errors[field.key] = `请输入 ${field.min}–${field.max} 范围内的${field.integer ? '整数' : '数值'}。`;
    }
    values[field.key] = value;
  }
  for (const field of promptFields) {
    const value = normalizePrompt(draft[field.key]);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(draft[field.key].replace(/\r\n?/g, '\n'))) {
      errors[field.key] = '提示词不能包含控制字符或不完整的 Unicode 字符；允许换行和制表符。';
    } else if (!value || Array.from(value).length > promptMaxLength) {
      errors[field.key] = `请输入 1–${promptMaxLength} 个字符的提示词。`;
    }
    values[field.key] = value;
  }
  if (!errors.upload_user_concurrency && !errors.upload_global_concurrency && values.upload_user_concurrency > values.upload_global_concurrency) {
    errors.upload_user_concurrency = errors.upload_global_concurrency = '单用户同时上传数不能超过全站同时上传数。';
  }
  if (!errors.upload_idle_timeout_seconds && !errors.upload_body_timeout_seconds && values.upload_idle_timeout_seconds > values.upload_body_timeout_seconds) {
    errors.upload_idle_timeout_seconds = errors.upload_body_timeout_seconds = '上传空闲超时不能超过单次上传最长时间。';
  }
  return {values, errors};
}
