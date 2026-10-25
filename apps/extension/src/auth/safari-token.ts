import {msg} from '../i18n/runtime';

/** Safari DNR does not strip Origin on extension fetches. The native handler
 * token branch accepts only token POSTs, with no cookies, redirects, storage or logging. */
export async function requestSafariToken(endpoint: string, body: string): Promise<Response> {
  if (typeof chrome.runtime.sendNativeMessage !== 'function')
    throw Error(msg('当前浏览器不支持安全登录，请更新浏览器后重试。'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply: unknown = await Promise.race([
      chrome.runtime.sendNativeMessage('net.nodelane.comics.safari.NodeLaneSafari', {type: 'oidc-token', endpoint, body}),
      new Promise((_, reject) => {timer = setTimeout(() => reject(Error('Native token request timed out')), 25000);}),
    ]);
    if (!reply || typeof reply !== 'object' || !('status' in reply) || !('body' in reply) ||
        !Number.isInteger(reply.status) || (reply.status as number) < 200 || (reply.status as number) > 599 ||
        typeof reply.body !== 'string' || reply.body.length > 131072)
      throw Error('Invalid native token response');
    const status = reply.status as number;
    return new Response([204, 205, 304].includes(status) ? null : reply.body, {status, headers: {'Content-Type': 'application/json'}});
  } catch {
    // Never surface native diagnostics containing endpoint URLs or credentials.
    throw Error(msg('未收到登录结果，请重新登录。'));
  } finally {clearTimeout(timer);}
}
