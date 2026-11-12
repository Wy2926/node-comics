import {attributes} from '../../shared/html';
import {catalogKey, catalogUrl, location, validId} from './definition';

export const changed = () => Error('RIDI 目录或阅读数据不完整，请回源确认后重试。');
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw changed();
  return value as Record<string, unknown>;
}
export function json(raw: string): Record<string, unknown> {
  try {return object(JSON.parse(raw));} catch {throw changed();}
}
export function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw changed();
  return value.trim();
}
export function source(url: string) {
  const loc = location(new URL(url));
  if (!loc) throw changed();
  return loc;
}
export function script(html: string, id: string): string {
  const matches = [...html.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => attributes(match[1]).id === id);
  if (matches.length !== 1 || attributes(matches[0][1]).type !== 'application/json') throw changed();
  return matches[0][2];
}
export function readerInfo(raw: string, url: string) {
  const loc = source(url), book = object(object(json(raw).detail).book);
  if (!loc.reader || book.b_id !== loc.bookId || !validId(book.series_id) || loc.seriesId && book.series_id !== loc.seriesId) throw changed();
  if (object(book.content_type).is_comic !== true) throw Error('RIDI 此页面不是网页漫画，暂不支持小说正文导入。');
  if (book.binding_type !== 'left' && book.binding_type !== 'right') throw changed();
  return {bookId: loc.bookId, seriesId: book.series_id, title: label(book.title), seriesTitle: label(book.series_title),
    direction: book.binding_type === 'right' && object(book.content_type).is_webtoon !== true ? 'rtl' as const : 'ltr' as const};
}
export function catalogInfo(raw: string, url: string) {
  const loc = source(url), section = object(object(object(json(raw).props).pageProps).sectionProps);
  if (loc.reader || section.bookId !== loc.bookId) throw changed();
  const cells = object(object(section.gridQuery).riGrid).grid;
  const rows = object(cells).cells;
  if (!Array.isArray(rows)) throw changed();
  const cell = (name: string) => {
    const found = rows.map(object).filter(row => row.type === name);
    if (found.length !== 1) throw changed();
    return found[0];
  };
  const header = object(cell('BookDetailHomeHeader').cell__BookDetailHomeHeader);
  const info = object(header.information), series = object(info.series);
  const metadata = object(cell('BookDetailHomeMetadata').cell__BookDetailHomeMetadata);
  const formats = object(metadata.fileInfo).formats;
  if (!Array.isArray(formats) || !formats.includes('WEBTOON') || object(metadata.supportEnvironment).webViewer !== true)
    throw Error('RIDI 当前仅支持提供网页阅读的条漫目录。');
  if (info.bookId !== loc.bookId || series.id !== loc.bookId || !Number.isSafeInteger(series.openedBookCount) ||
    !Number.isSafeInteger(series.openedTrialBookCount)) throw changed();
  const total = Number(series.openedBookCount) + Number(series.openedTrialBookCount);
  if (Number(series.openedBookCount) < 1 || Number(series.openedTrialBookCount) < 0 || total > 10000) throw changed();
  const episodes = cell('BookDetailHomeEpisodeBookList');
  if (typeof episodes.id !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(episodes.id)) throw changed();
  const title = label(object(info.title).title);
  return {title, total, cellId: episodes.id, list: object(episodes.cell__BookDetailHomeEpisodeBookList),
    seriesId: loc.bookId, catalogId: catalogKey(loc.bookId), catalogUrl: catalogUrl(loc.bookId)};
}
