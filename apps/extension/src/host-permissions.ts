import {msg} from './i18n/runtime';
import {isSafariExtension} from './platform';

export const websiteOrigins = ['https://*/*', 'http://*/*'] as const;
/** WebExtension match patterns scope scheme/host, not TCP ports (Safari rejects them). */
export function hostPermissionPattern(value:string):string {
  const url=new URL(value);
  return `${url.protocol}//${url.hostname}/*`;
}
export async function openHostAccessSettings(){
  if(typeof chrome==='undefined'||!chrome.runtime?.id)return;
  await chrome.tabs.create({url:isSafariExtension()?chrome.runtime.getURL('/safari.html'):
    navigator.userAgent.includes('Firefox/')?'about:addons':'chrome://extensions/?id='+chrome.runtime.id});
}

/** Installation grants host access; browser restrictions are checked, never re-requested per site. */
export async function requireHostAccess(origins: readonly string[] = websiteOrigins): Promise<void> {
  if (!origins.length || typeof chrome === 'undefined' || !chrome.runtime?.id) return;
  if (!await chrome.permissions.contains({origins: [...new Set(origins.map(hostPermissionPattern))]})) {
    throw Error(msg('网站访问权限已被浏览器关闭，请在扩展设置中允许访问所有网站后重试。'));
  }
}
