import { withPageDocument } from './page-document';
import { readCoverInPage } from './page-cover-request';
import { requireImagePermissions } from './permissions';
import { safeImageUrl } from '../shared/urls';
import { SourceHttpError, sourceRetryAfter } from './http';
import { msg } from '../../i18n/runtime';
/** Only called for adapter-validated artwork explicitly configured to use an image document. */
export async function readPageCover(url: string, signal?: AbortSignal): Promise<Blob> {
  const lifetime = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
  lifetime.throwIfAborted();
  if (safeImageUrl(url, url) !== url)
    throw new SourceHttpError('request-denied', '来源请求地址无效。');
  await requireImagePermissions([url]);
  lifetime.throwIfAborted();
  const authorize = async (signal: AbortSignal, target = url) => { await requireImagePermissions([url, target]); signal.throwIfAborted(); };
  return withPageDocument({ url, matches: target => target === url, authorize, exact: true, followRedirects: true }, lifetime, async (page) => {
    await requireImagePermissions([url, page.url]);
    page.signal.throwIfAborted();
    const result = await page.request(readCoverInPage, {});
    await requireImagePermissions([url, page.url]);
    page.signal.throwIfAborted();
    const invalid = () => new SourceHttpError('invalid-response', '来源响应无效或超过限制。');
    if (!result || result.pageUrl !== page.url || !Number.isInteger(result.status) || result.status < 0 || result.status > 599 ||
      typeof result.data !== 'string' || result.data.length > Math.ceil(4 * 1024 * 1024 / 3) * 4)
      throw invalid();
    if (typeof result.responseUrl !== 'string' || safeImageUrl(result.responseUrl, result.responseUrl) !== result.responseUrl) throw invalid();
    await requireImagePermissions([result.responseUrl]);
    page.signal.throwIfAborted();
    if (result.error === 'changed')
      throw Error(msg('来源页面已变化，请重新发现。'));
    if (result.error === 'size' || result.error === 'type')
      throw invalid();
    if (result.error)
      throw Error(msg('图片网络请求失败，请检查连接或刷新来源页面后重试。'));
    if (result.challenge || result.status === 401 || result.status === 403)
      throw new SourceHttpError('http', `来源请求失败（HTTP ${result.status}），请打开来源页面完成登录或验证后重试。`, { status: result.status });
    if (result.status < 200 || result.status >= 300)
      throw new SourceHttpError('http', msg('来源图片获取失败（HTTP {0}），可重新解析后补齐。', { '0': result.status }), { status: result.status, retryAfter: sourceRetryAfter(result.retryAfter) });
    if (typeof result.type !== 'string' || !/^image\/(?:avif|bmp|gif|jpeg|jpg|png|webp)$/.test(result.type) ||
      !result.data || result.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data))
      throw invalid();
    const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length > 4 * 1024 * 1024)
      throw invalid();
    return new Blob([bytes], { type: result.type });
  });
}
