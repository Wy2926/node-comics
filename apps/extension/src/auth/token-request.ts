import {secureIdentityUrl} from './model';

// Outside the source-image rule range (800000..899999).
const ruleId = 700000;

/** Firefox's per-profile Origin cannot be registered for every installation.
 * Keep the direct public-client exchange and remove it only from our token POST. */
export async function requestOidcToken(endpoint: string, body: URLSearchParams): Promise<Response> {
  const url = secureIdentityUrl(endpoint);
  url.hash = '';
  const send = () => fetch(url.href, {
    method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(15000), headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body,
  });
  const extensionUrl = typeof chrome !== 'undefined' ? chrome.runtime?.getURL?.('') : undefined;
  if (!extensionUrl?.startsWith('moz-extension://')) return send();

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
