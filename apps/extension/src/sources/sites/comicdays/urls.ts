import {protocolChanged} from '../../shared/gigaviewer/pages';

export function pageUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192) throw protocolChanged();
  const url = new URL(value);
  if (url.origin !== 'https://cdn-img.comic-days.com' || url.username || url.password ||
      !/^\/public\/page\/(?:\d+\/)?[1-9]\d*-[a-f\d]+$/.test(url.pathname)) throw protocolChanged();
  return url.href;
}
