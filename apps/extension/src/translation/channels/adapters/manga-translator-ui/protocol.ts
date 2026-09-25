import {msg} from '../../../../i18n/runtime';
import type {Mode} from '../../../../types';
import {ImageTransferError, type ImageTransferRequest} from '../../transport/types';

// hgmzhn/manga-translator-ui @ 2130ccb: translators/common.py VALID_LANGUAGES.
export const languages: Readonly<Record<string, string>> = {
  'zh-Hans': 'CHS', 'zh-Hant': 'CHT', en: 'ENG', ja: 'JPN', ko: 'KOR', fr: 'FRA', es: 'ESP',
  'pt-BR': 'PTB', de: 'DEU', it: 'ITA', ru: 'RUS', pl: 'POL', uk: 'UKR', tr: 'TRK', vi: 'VIN', id: 'IND',
};
export function serviceBase(value: string): string {
  let url: URL;
  try {url = new URL(value.trim());} catch {throw Error(msg('请输入有效的 HTTP 或 HTTPS 服务地址。'));}
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Error(msg('服务地址不能包含凭据、查询参数或片段。'));
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.href;
}
export function safeError(code: string): string {
  if (code === 'HTTP_401' || code === 'HTTP_403') return msg('翻译服务登录已失效或无权限，请在渠道设置中重新连接。');
  if (code === 'HTTP_429') return msg('翻译服务繁忙或已达到限制，请稍后重试。');
  if (code === 'HTTP_404') return msg('翻译接口不存在，请检查服务地址和版本。');
  if (code === 'HTTP_400' || code === 'HTTP_422' || code === 'UNSUPPORTED_LANGUAGE' || code === 'UNSUPPORTED_MODE')
    return msg('翻译服务不支持当前图片、语言或参数。');
  if (code === 'SOURCE_MISSING') return msg('本地原图尚未就绪，请重新采集。');
  if (code === 'SOURCE_CHANGED') return msg('原图内容已变化，请重新加载后翻译。');
  if (code === 'INVALID_IMAGE') return msg('翻译服务未返回可解码的图片。');
  if (code === 'IMAGE_TOO_LARGE') return msg('图片尺寸超过翻译服务限制。');
  if (code === 'RESULT_MISSING' || code === 'RESULT_NOT_CACHED') return msg('本地译图缓存已清理，请手动重新翻译。');
  if (code === 'HOST_UNAVAILABLE') return msg('翻译执行页面无法打开，请重新尝试。');
  if (code === 'INTERRUPTED') return msg('翻译连接已中断，服务可能仍在处理。确认后可手动重试。');
  return msg('翻译服务处理失败，请检查服务后手动重试。');
}
export function translationRequest(base: string, token: string, mode: Mode, language: string): ImageTransferRequest {
  if (mode !== 'classic') throw new ImageTransferError('UNSUPPORTED_MODE');
  const target = languages[language];
  if (!target) throw new ImageTransferError('UNSUPPORTED_LANGUAGE');
  if (!token) throw new ImageTransferError('HTTP_401');
  return {
    url: base + 'translate/with-form/image', headers: {'X-Session-Token': token}, imageField: 'image',
    fields: {config: JSON.stringify({translator: {target_lang: target}})},
    maxBytes: 32 * 1024 * 1024, maxPixels: 40_000_000, maxDimension: 30000,
  };
}

export async function login(base: string, username: string, password: string, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(base + 'auth/login', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username, password}),
      credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch {throw Error(msg('无法连接翻译服务，请检查地址、访问权限和服务状态。'));}
  if (!response.ok) throw Error(safeError('HTTP_' + response.status));
  let result: {success?: unknown; token?: unknown; must_change_password?: unknown};
  try {
    const text = await response.text();
    if (text.length > 65536) throw Error();
    result = JSON.parse(text);
  } catch {throw Error(msg('翻译服务返回的登录响应无效。'));}
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.success !== 'boolean')
    throw Error(msg('翻译服务返回的登录响应无效。'));
  if (!result.success) throw Error(msg('翻译服务登录失败，请检查用户名和密码。'));
  if (result.must_change_password === true) throw Error(msg('请先在翻译服务页面修改初始密码，再重新连接。'));
  if (typeof result.token !== 'string' || !result.token || result.token.length > 8192 || /[\r\n]/.test(result.token))
    throw Error(msg('翻译服务返回的登录响应无效。'));
  return result.token;
}
