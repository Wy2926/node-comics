import {msg} from './i18n/runtime';

export const websiteOrigins = ['https://*/*', 'http://*/*'] as const;

/** Installation grants host access; browser restrictions are checked, never re-requested per site. */
export async function requireHostAccess(origins: readonly string[] = websiteOrigins): Promise<void> {
  if (!origins.length || typeof chrome === 'undefined' || !chrome.runtime?.id) return;
  if (!await chrome.permissions.contains({origins: [...new Set(origins)]})) {
    throw Error(msg('网站访问权限已被浏览器关闭，请在扩展设置中允许访问所有网站后重试。'));
  }
}
