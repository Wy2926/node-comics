import {msg} from '../../i18n/runtime';
export const MiB = 1024 * 1024;
export const MAX_FILE = 512 * MiB;
export const MAX_PAGE = 32 * MiB;
export const MAX_EXPANDED = 1024 * MiB;
export const MAX_PAGES = 1500;
export const MAX_ENTRIES = 10000;
export const COMIC_ACCEPT = 'image/png,image/jpeg,image/webp,.mobi,.cbz,.zip,.cbr,.rar,.pdf';
export const isComicFile = (name: string) => /\.(mobi|cbz|zip|cbr|rar|pdf)$/i.test(name);

export const imageMime = (name: string) => ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'}[name.split('.').at(-1)!.toLowerCase()]);
export function comicImage(name: string) {
  const parts = name.replaceAll('\\', '/').split('/');
  return !!imageMime(name) && !parts.some(p => p.startsWith('.') || p === '__MACOSX');
}
// Fixed locale and binary tie-breaker preserve page identities across devices.
export function comparePaths(a: {name: string}, b: {name: string}) {
  return a.name.localeCompare(b.name, 'en', {numeric:true, sensitivity:'base'}) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export function validateEntries<T extends {name:string; size:number; encrypted?:boolean}>(entries:T[], limit=MAX_EXPANDED) {
  let expanded=0;
  for(const entry of entries) {
    if(entry.encrypted)throw Error(msg("暂不支持加密压缩包，请先在本机解密后导入。"));
    if(!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>MAX_PAGE)throw Error(msg("压缩包单个文件不能超过 32 MB。"));
    expanded+=entry.size;
    if(expanded>limit)throw Error(msg("压缩包展开大小超过 {0} MB，请拆分为较小章节。", {"0": limit/MiB}));
  }
  const images=entries.filter(entry=>comicImage(entry.name)).sort(comparePaths);
  if(!images.length)throw Error(msg("压缩包内没有 PNG、JPEG、WebP 或 GIF 漫画图片。"));
  if(images.length>MAX_PAGES)throw Error(msg("单卷最多支持 1500 页。"));
  if(new Set(images.map(e=>e.name)).size!==images.length)throw Error(msg("压缩包中存在同路径重名图片，请整理后重新导入。"));
  return images;
}
