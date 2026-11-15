import {attributes, inertHtml, tags} from '../../shared/html';
import {batcaveLocation, origin, type BatcaveLocation} from './definition';

export const invalid = () => Error('BatCave 未返回可用的作品或阅读数据。');
export function text(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 2048 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw invalid();
  return normalized;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export function integer(value: unknown, max = 999999999999): number {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw invalid();
  return value;
}
export function location(value: string) {
  const loc = batcaveLocation(new URL(text(value), origin));
  if (!loc) throw invalid();
  return loc;
}
export function regions(html: string, tag: string, select: (attrs: Record<string, string>) => boolean) {
  const result: Array<{attrs: Record<string, string>; body: string}> = [];
  let selected: {attrs: Record<string, string>; start: number} | undefined, depth = 0;
  for (const token of html.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'))) {
    if (/^<\//.test(token[0])) {
      if (selected && --depth === 0) {
        result.push({attrs: selected.attrs, body: html.slice(selected.start, token.index)}); selected = undefined;
      }
    } else if (selected) depth++;
    else {
      const attrs = attributes(token[0]);
      if (select(attrs)) {selected = {attrs, start: token.index! + token[0].length}; depth = 1;}
    }
  }
  if (selected) throw invalid();
  return result;
}
export function pageData(html: string, expected: BatcaveLocation) {
  const safe = inertHtml(html), canonical = tags(safe, 'link').find(a => a.rel === 'canonical');
  const actual = canonical?.href ? location(canonical.href) : expected;
  if (actual.work !== expected.work || actual.chapter !== expected.chapter) throw invalid();
  const scripts = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(m => !attributes(' ' + m[1]).src && /^\s*window\.__DATA__\s*=/.test(m[2]));
  // Parse only the JSON assignment; the reader's following truncation script is never executed.
  const raw = /^\s*window\.__DATA__\s*=\s*(\{[\s\S]*\})\s*(?:;|$)/.exec(scripts.at(-1)?.[2] ?? '')?.[1];
  let data: Record<string, unknown>;
  try {data = object(JSON.parse(raw ?? ''));} catch {throw invalid();}
  if (String(integer(data.news_id)) !== expected.work ||
      expected.chapter && String(integer(data.chapter_id)) !== expected.chapter) throw invalid();
  return {data, safe, actual};
}
export function readerWork(data: Record<string, unknown>, loc: BatcaveLocation) {
  if (!loc.chapter || String(integer(data.chapter_id)) !== loc.chapter) throw invalid();
  const parent = location(text(data.post_link));
  if (parent.chapter || parent.work !== loc.work) throw invalid();
  return parent;
}
export function imageUrl(value: unknown, loc: BatcaveLocation) {
  const url = new URL(text(value));
  if (url.origin !== 'https://img.batcave.biz' || url.username || url.password || url.hash ||
      !new RegExp(`^/img/\\d+/${loc.work}/${loc.chapter}/[^/]+$`).test(url.pathname)) throw invalid();
  return url;
}
