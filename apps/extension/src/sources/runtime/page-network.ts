import type { SourceNetworkContext } from '../contracts/network';
import { resolveSource } from '../core/resolve';
import { definitions } from '../registry/definitions';
import { authorizeSourceRequest, SourceHttpError, sourceRetryAfter } from './http';
import { requestInSourcePage } from './page-request';
import { withPageDocument } from './page-document';
import { msg } from '../../i18n/runtime';
/** One bounded source-page session at a time across extension pages; no HTTP-failure fallback. */
export async function withPageNetworkContext<T>(url: string, signal: AbortSignal, read: (context: SourceNetworkContext) => Promise<T>): Promise<T> {
  await authorizeSourceRequest(url, url, undefined, signal);
  const source = resolveSource(url, definitions).location, origin = new URL(url).origin;
  // Open the work landing page, not the chapter reader with its eager image downloads.
  const pageSource = source.catalog?.url ?? url;
  const matches = (target: string | undefined) => {
    if (!target)
      return false;
    try {
      const loc = resolveSource(target, definitions).location;
      return new URL(target).origin === origin && loc.sourceId === source.sourceId &&
        !!source.catalog && loc.catalog?.key === source.catalog.key && loc.kind !== 'other';
    }
    catch {
      return false;
    }
  };
  const authorize = (signal: AbortSignal) => authorizeSourceRequest(url, pageSource, undefined, signal);
  return withPageDocument({ url: pageSource, matches, authorize }, signal, page => read({
    signal: page.signal, async request(target, options) {
      const body = await authorizeSourceRequest(url, target, options, page.signal, [origin + '/*']);
      const result = await page.request(requestInSourcePage, { url: target, referer: options?.referer, body });
      await authorizeSourceRequest(url, target, undefined, page.signal, [origin + '/*']);
      if (!result || result.pageUrl !== page.url || typeof result.body !== 'string' || result.body.length > 8 * 1024 * 1024 ||
        !Number.isInteger(result.status) || result.status < 0 || result.status > 599)
        throw new SourceHttpError('invalid-response', '来源响应无效或超过限制。');
      if (result.error === 'changed')
        throw Error(msg('来源页面已变化，请重新发现。'));
      if (result.error === 'size')
        throw new SourceHttpError('invalid-response', '来源响应超过限制。');
      if (result.error && result.status === 0)
        throw new SourceHttpError('http', '来源网络请求失败或超时，请稍后重试。');
      const accepted = result.status >= 400 && result.status <= 599 && options?.acceptStatuses?.includes(result.status);
      if (result.challenge || (result.status === 401 || result.status === 403) && !accepted)
        throw new SourceHttpError('http', `来源请求失败（HTTP ${result.status}），请打开来源页面完成登录或验证后重试。`, { status: result.status });
      if ((result.status < 200 || result.status >= 300) && !accepted)
        throw new SourceHttpError('http', `来源请求失败（HTTP ${result.status}），请稍后重试。`, { status: result.status, retryAfter: sourceRetryAfter(result.retryAfter) });
      if (result.error)
        throw new SourceHttpError('http', '来源网络请求失败或超时，请稍后重试。');
      return result.body;
    }
  }));
}
