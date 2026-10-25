import {secureIdentityUrl} from './model';
import {msg} from '../i18n/runtime';
import {isSafariExtension} from '../platform';
import {requestSafariToken} from './safari-token';

// Outside the source-image rule range (800000..899999).
const ruleId = 700000;

/** Public-client exchange; Safari uses the container's credential-free transport. */
export async function requestOidcToken(endpoint: string, body: URLSearchParams): Promise<Response> {
  const url = secureIdentityUrl(endpoint);
  url.hash = '';
  if (isSafariExtension()) return requestSafariToken(url.href, body.toString());
  const send = () => fetch(url.href, {
    method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(15000), headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body,
  });
  const extensionUrl = typeof chrome !== 'undefined' ? chrome.runtime?.getURL?.('') : undefined;
  if (!extensionUrl?.startsWith('moz-extension://')) return send();
  if (!chrome.declarativeNetRequest?.updateSessionRules)
    throw Error(msg('当前浏览器不支持安全登录，请更新浏览器后重试。'));

  // Extension pages share the rule; serialize exchanges and always remove it.
  return navigator.locks.request('nc-oidc-token-origin', async () => {
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [ruleId], addRules: [{
      id: ruleId, priority: 1,
      action: {type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [{header: 'Origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation}]},
      condition: {initiatorDomains: [new URL(extensionUrl).hostname],
        regexFilter: '^' + url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', isUrlFilterCaseSensitive: true,
        requestMethods: ['post' as chrome.declarativeNetRequest.RequestMethod],
        resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType]},
    }]});
    try {return await send();}
    finally {await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [ruleId]});}
  });
}
