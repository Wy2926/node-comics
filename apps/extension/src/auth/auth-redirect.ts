import {msg} from '../i18n/runtime';
import {API_BASE} from '../service';
import {isSafariExtension} from '../platform';
import {secureIdentityUrl} from './model';

/** Keep the registered desktop callback when a mobile browser has no identity API. */
export async function loginRedirectUrl(apiBase = API_BASE): Promise<string> {
  if (typeof chrome.identity?.getRedirectURL === 'function') return chrome.identity.getRedirectURL('oidc');
  // Reuse our registered website callback. A random Safari extension origin
  // cannot be registered as a public client's redirect URI for every install.
  if (isSafariExtension()) return secureIdentityUrl(new URL('/auth/callback/', apiBase).href).href;
  const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
    browser_specific_settings?: {gecko?: {id?: string}};
  };
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (!id) throw Error(msg('当前浏览器不支持安全登录，请更新浏览器后重试。'));
  // Firefox identity.getRedirectURL derives this hostname from the fixed Gecko ID.
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(id));
  const host = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `https://${host}.extensions.allizom.org/oidc`;
}
