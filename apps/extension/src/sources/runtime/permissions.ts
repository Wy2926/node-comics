import { msg } from '../../i18n/runtime';

export const imageOrigins = (urls: string[]) => [...new Set(urls.filter(url=>/^https?:/.test(url)).map((url) => new URL(url).origin + '/*'))];
export class ImagePermissionsRequired extends Error {
  constructor() {
    super(msg('网站访问权限已被浏览器关闭，请在扩展设置中允许访问所有网站后重试。'));
  }
}
export async function requireImagePermissions(urls: string[]) {
  const origins = imageOrigins(urls);
  if (origins.length && !(await chrome.permissions.contains({ origins })))
    throw new ImagePermissionsRequired();
}
