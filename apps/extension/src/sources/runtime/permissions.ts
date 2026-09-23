import { msg } from '../../i18n/runtime';
import type { SourceCatalog } from '../../comics/application/types';
import type { ReadingCopy } from '../../types';
import { discoverEntry, inExtension } from './client';

export const imageOrigins = (urls: string[]) => [...new Set(urls.map((url) => new URL(url).origin + '/*'))];
export const copyOrigins = (copies: ReadingCopy[]) =>
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
export async function prepareImageOrigins(catalog: SourceCatalog, entryId: string, signal: AbortSignal) {
  const first = await discoverEntry(catalog, entryId, signal, async () => {}, undefined, true);
  return imageOrigins(first.items.map((item) => item.url));
}
export class ImagePermissionsRequired extends Error {
  constructor() {
    super(msg('需要授权图片域名。点击“授权并继续”后开始下载，已发现链接已保留。'));
  }
}
export async function requireImagePermissions(urls: string[]) {
  const origins = imageOrigins(urls);
  if (origins.length && !(await chrome.permissions.contains({ origins })))
    throw new ImagePermissionsRequired();
}
