import {attributes} from '../../shared/html';
import {episodeCode, location, origin, workCode} from './definition';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('ComicWalker 数据格式已变化。');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('ComicWalker 数据字段无效。');
  return value.trim();
}
export function list(value: unknown, max = 10000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw Error('ComicWalker 清单无效。');
  return value;
}
export function count(value: unknown, min = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw Error('ComicWalker 页数或序号无效。');
  return value as number;
}
export function completeList(value: unknown) {
  const data = record(value), rows = list(data.result);
  if (count(data.total) !== rows.length) throw Error('ComicWalker 目录尚未完整返回。');
  return rows.map(record);
}
export function nextData(html: string) {
  const matches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .filter(m => attributes(m[0].slice(0, m[0].indexOf('>') + 1)).id === '__NEXT_DATA__');
  if (matches.length !== 1) throw Error('ComicWalker 页面数据不可用，请在源站完成验证后重试。');
  return matches[0][1];
}
export function pageData(raw: string, url: string) {
  const loc = location(new URL(url));
  if (!loc || raw.length > 8 * 1024 * 1024) throw Error('ComicWalker 页面地址无效。');
  const props = record(record(record(JSON.parse(raw)).props).pageProps);
  const work = text(props.workCode), episode = typeof props.episodeCode === 'string' ? props.episodeCode : undefined;
  if (!workCode.test(work) || loc.work && work !== loc.work || loc.episode && episode !== loc.episode ||
    episode && (!episodeCode.test(episode) || episode.slice(3, 9) !== work.slice(3, 9)))
    throw Error('ComicWalker 作品或章节归属不符。');
  const queries = list(record(props.dehydratedState).queries, 100).map(record);
  function query(path: string) {
    const matches = queries.filter(q => Array.isArray(q.queryKey) && q.queryKey[0] === path &&
      record(q.queryKey[1]).workCode === work);
    if (matches.length !== 1) throw Error('ComicWalker 页面元数据缺失。');
    return record(record(matches[0].state).data);
  }
  const details = query('/api/contents/details/work'), metadata = record(details.work);
  if (metadata.code !== work || metadata.id !== props.workId) throw Error('ComicWalker 作品身份不符。');
  return {props, work, episode, details, metadata, query};
}
export function artwork(value: unknown) {
  const url = new URL(text(value, 8192));
  if (url.origin !== 'https://cdn.comic-walker.com' || url.username || url.password ||
    !url.pathname.startsWith('/integration/')) throw Error('ComicWalker 封面地址无效。');
  return {url: url.href};
}
export const uuid = (value: unknown) => {
  const id = text(value, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw Error('ComicWalker 章节标识无效。');
  return id;
};
export const viewerUrl = (id: string) => `${origin}/api/contents/viewer?episodeId=${uuid(id)}&imageSizeType=width%3A1284`;
