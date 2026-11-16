import {SourceProtocolError} from '../../contracts/network';
import {tags, textContent} from '../../shared/html';
import type {MangagoLocation} from './definition';
import {checkedHtml, location, one, region, regions, resourceUrl, text} from './html';

/** Public reader protocol: https://pic1.mangapicgallery.com/js/chapter.js?895 (2026-11-15). */
export async function decodeImageList(encoded: string) {
  if (encoded.length > 4 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new SourceProtocolError('Mangago 图片清单编码无效。');
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length % 16) throw new SourceProtocolError('Mangago 图片清单长度无效。');
  const hex = (value: string) => Uint8Array.from(value.match(/../g)!, b => parseInt(b, 16));
  const key = await crypto.subtle.importKey('raw', hex('e11adc3949ba59abbe56e057f20f883e'), 'AES-CBC', false, ['encrypt', 'decrypt']);
  // WebCrypto requires PKCS#7: append one encrypted padding block to decode the source's zero padding.
  const padding = await crypto.subtle.encrypt({name: 'AES-CBC', iv: bytes.slice(-16)}, key, new Uint8Array());
  const padded = new Uint8Array(bytes.length + 16); padded.set(bytes); padded.set(new Uint8Array(padding), bytes.length);
  try {
    const clear = await crypto.subtle.decrypt({name: 'AES-CBC', iv: hex('1234567890abcdef1234567890abcdef')}, key, padded);
    return new TextDecoder('utf-8', {fatal: true}).decode(clear).replace(/\0+$/, '').split(',');
  } catch {throw new SourceProtocolError('Mangago 图片清单协议已变化。');}
}
export function imageUrl(value: string, work?: string) {
  const url = resourceUrl(value);
  const match = /^\/r\/(newpiclink|cspiclink)\/([a-z0-9_-]+)\/\d+\/([a-zA-Z0-9_-]+)\.(jpe?g|png|webp)$/.exec(url.pathname);
  if (!match || work && match[2] !== work || url.search && url.search !== '?1') throw Error('Mangago 正文图片归属无效。');
  // The public reader removes this transport marker before loading either image format.
  if (match[3][6] === 'z') url.pathname = url.pathname.replace(match[3] + '.', match[3].slice(0, 6) + match[3].slice(7) + '.');
  return url.href;
}
export function readerData(html: string, expected: MangagoLocation) {
  if (!expected.chapter) throw Error('Mangago 章节地址无效。');
  const safe = checkedHtml(html, expected), series = one(regions(safe, 'a', a => a.id === 'series'));
  const parent = location(text(series.attrs.href));
  if (parent.work !== expected.work || parent.chapter) throw Error('Mangago 章节作品归属错误。');
  const title = text(textContent(series.body));
  const scripts = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(s => !/\bsrc\s*=/i.test(s[1])).map(s => s[2]);
  const encoded = one(scripts.flatMap(script => [...script.matchAll(/(?:^|\n)\s*var\s+imgsrcs\s*=\s*'([A-Za-z0-9+/=]+)'\s*;/g)].map(m => m[1])));
  const identity = one(scripts.filter(s => /^var pcurl\s*=/m.test(s)));
  const pcurl = one([...identity.matchAll(/\bpcurl\s*=\s*("(?:[^"\\]|\\.)*")/g)]);
  const actual = location(JSON.parse(pcurl[1]));
  const total = Number(one([...identity.matchAll(/\btotal_pages\s*=\s*(\d+)\s*[,;]/g)])[1]);
  if (actual.work !== expected.work || actual.chapter !== expected.chapter || !Number.isSafeInteger(total) || total < 1 || total > 1500)
    throw Error('Mangago 当前章节身份或总页数错误。');
  const pager = region(safe, 'ul', a => a.id === 'dropdown-menu-page'), slots = regions(pager, 'a');
  // The server leaves the pager empty; the source script fills it from total_pages.
  if (slots.length && slots.length !== total || slots.length !== tags(pager, 'a').length) throw Error('Mangago 正文页数不完整。');
  slots.forEach((slot, index) => {
    const target = location(text(slot.attrs.href));
    if (target.work !== expected.work || target.chapter !== expected.chapter || target.page !== index + 1 ||
        textContent(slot.body).toLowerCase() !== `page ${index + 1} of ${total}`) throw Error('Mangago 正文页序不一致。');
  });
  const chapterTitle = text(textContent(region(safe, 'title'))).replace(/ Page \d+ - Mangago$/, '');
  if (!chapterTitle.startsWith(title + ' ')) throw Error('Mangago 章节标题归属错误。');
  return {title: chapterTitle, total, encoded};
}
