import { msg } from '../../i18n/runtime';
import type { ReadingEntry } from '../../types';
import { inExtension } from './client';

export const imageOrigins = (urls: string[]) => [...new Set(urls.filter(url=>/^https?:/.test(url)).map((url) => new URL(url).origin + '/*'))];
export const copyOrigins = (copies: ReadingEntry[]) =>
  imageOrigins(
    copies.flatMap((c) => [
      ...(c.sourceUrl ? [c.sourceUrl] : []),
      ...c.pages.flatMap((p) => (p.sourceUrl ? [p.sourceUrl] : [])),
    ]),
  );
export async function requestImagePermissions(origins: string[]) {
  // This call must happen synchronously from a click, before any storage/network await.
  if (
    origins.length &&
    inExtension() &&
    !(await chrome.permissions.request({ origins: [...new Set(origins)] }))
  )
    throw Error(msg('图片域名未获授权；尚未开始下载，可再次授权。'));
}
export class ImagePermissionsRequired extends Error {
  constructor(readonly origins:string[]) {
    super(msg('需要授权图片域名。点击“授权并继续”后开始下载，已发现链接已保留。'));
  }
}
export async function requireImagePermissions(urls: string[]) {
  const origins = imageOrigins(urls);
  if (origins.length && !(await chrome.permissions.contains({ origins })))
    throw new ImagePermissionsRequired(origins);
}
