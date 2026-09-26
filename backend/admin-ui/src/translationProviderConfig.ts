import type {TranslationChannel, TranslationProtocol, TranslationProvider, TranslationProviderConfig, TranslationProviderInput} from './types';

export const providerEndpoint = '/v1/admin/translation-providers';
export const protocolLabels: Record<TranslationProtocol, string> = {
  chat_completions: 'Chat Completions', responses: 'Responses',
};
export const numericFields = [
  {key: 'timeout_seconds', title: '请求超时', unit: '秒', min: 1, max: 180, integer: true, group: 'requests', help: '每次文本请求的超时时间。'},
  {key: 'max_attempts', title: '最多尝试次数', unit: '次', min: 1, max: 3, integer: true, group: 'requests', help: '仅用于正文，包含首次请求；漫画名查询不自动重试。'},
  {key: 'max_output_tokens', title: '最大输出长度', unit: 'token', min: 128, max: 8192, integer: true, group: 'requests', help: '单次文本调用允许的最大输出长度。'},
  {key: 'group_bytes', title: '文本分组大小', unit: '字节', min: 128, max: 16000, integer: true, group: 'requests', help: '仅用于正文，控制每组待翻译文本的大小。'},
  {key: 'requests_per_minute', title: '每分钟请求上限', unit: '次 / 分钟', min: 1, max: 10000, integer: true, group: 'requests', help: '此供应商的正文请求速率限制；漫画名固定每用户每分钟 30 次。'},
  {key: 'input_rate', title: '输入单价', unit: '元 / 百万 token', min: 0, max: 1000, integer: true, group: 'pricing', help: '用于记录输入成本，可填写 0。'},
  {key: 'output_rate', title: '输出单价', unit: '元 / 百万 token', min: 0, max: 5000, integer: true, group: 'pricing', help: '用于记录输出成本，可填写 0。'},
] as const;
export const textLimits = {name: 100, base_url: 1000, model: 120, user_agent: 200, pricing_version: 100, api_key: 4096} as const;

// These are the new provider API defaults, independent of legacy text settings.
const defaults: TranslationProviderConfig = {
  base_url: 'https://api.openai.com/v1', model: '', protocol: 'chat_completions', user_agent: 'NodeComics/0.1',
  timeout_seconds: 60, max_attempts: 3, max_output_tokens: 1024, group_bytes: 1800,
  input_rate: 5, output_rate: 30, pricing_version: 'operator-estimate-v1', requests_per_minute: 60,
};
export type ProviderDraft = Record<keyof TranslationProviderConfig | 'name' | 'channel' | 'api_key', string> & {enabled: boolean};
export type ProviderField = Exclude<keyof ProviderDraft, 'enabled'>;
export type ProviderErrors = Partial<Record<ProviderField, string>>;

export function providerDraft(provider?: TranslationProvider): ProviderDraft {
  const config = provider?.config ?? defaults;
  return {
    ...Object.fromEntries(Object.keys(defaults).map(key => [key, String(config[key as keyof TranslationProviderConfig])])) as Record<keyof TranslationProviderConfig, string>,
    name: provider?.name ?? '', channel: provider?.channel ?? 'openai', enabled: provider?.enabled ?? true, api_key: '',
  };
}

export const channelProtocols = (channels: TranslationChannel[], channel: string): TranslationProtocol[] =>
  channel === 'openai' ? (channels.find(item => item.id === channel)?.protocols ?? [])
    .filter((protocol): protocol is TranslationProtocol => Object.hasOwn(protocolLabels, protocol)) : [];

export function validateProvider(draft: ProviderDraft, channels: TranslationChannel[], creating: boolean): ProviderErrors {
  const errors: ProviderErrors = {};
  for (const [key, title] of [['name', '供应商名称'], ['model', '模型'], ['user_agent', 'User-Agent'], ['pricing_version', '计价版本']] as const) {
    if (!draft[key].trim()) errors[key] = `请填写${title}。`;
  }
  if (/[^\x20-\x7e]/.test(draft.user_agent.trim())) errors.user_agent = 'User-Agent 只能包含可打印的 ASCII 字符，不能包含换行符。';
  if (!channelProtocols(channels, draft.channel).length) errors.channel = '当前渠道暂不可配置，请选择可用的 OpenAI 渠道。';
  if (!channelProtocols(channels, draft.channel).includes(draft.protocol as TranslationProtocol)) errors.protocol = '请选择此渠道支持的接口协议。';
  try {
    const address = draft.base_url.trim();
    const url = new URL(address);
    if (!/^https:\/\//i.test(address) || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || /[^\x21-\x7e]/.test(address)) throw Error();
  } catch {errors.base_url = '请填写 HTTPS API 基础地址，使用 ASCII 字符，不包含空白、登录信息、查询参数或片段。';}
  if ((creating || draft.api_key !== '') && !draft.api_key.trim()) errors.api_key = creating ? '创建供应商时必须填写 API 密钥。' : '密钥不能只包含空白；保留原密钥请清空此输入框。';
  if (/[^\x21-\x7e]/.test(draft.api_key.trim())) errors.api_key = 'API 密钥只能包含可打印的 ASCII 字符，不能包含空白或换行符。';
  for (const key of Object.keys(textLimits) as (keyof typeof textLimits)[]) {
    if (Array.from(draft[key].trim()).length > textLimits[key]) errors[key] = `最多填写 ${textLimits[key]} 个字符。`;
  }
  for (const field of numericFields) {
    const value = Number(draft[field.key]);
    if (!draft[field.key].trim() || !Number.isFinite(value) || value < field.min || value > field.max || (field.integer && !Number.isInteger(value))) {
      errors[field.key] = `请输入 ${field.min}–${field.max} 范围内的${field.integer ? '整数' : '数值'}。`;
    }
  }
  return errors;
}

// Call only after validation. Never serialize a blank replacement credential.
export function providerInput(draft: ProviderDraft): TranslationProviderInput {
  return {
    name: draft.name.trim(), channel: 'openai', enabled: draft.enabled,
    config: {
      base_url: draft.base_url.trim(), model: draft.model.trim(), protocol: draft.protocol as TranslationProtocol,
      user_agent: draft.user_agent.trim(), pricing_version: draft.pricing_version.trim(),
      ...Object.fromEntries(numericFields.map(field => [field.key, Number(draft[field.key])])) as Pick<TranslationProviderConfig, typeof numericFields[number]['key']>,
    },
    ...(draft.api_key.trim() ? {api_key: draft.api_key.trim()} : {}),
  };
}
