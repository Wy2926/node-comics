import type {SourceNetworkContext} from '../../contracts/network';
import {attributes, tags} from '../../shared/html';
import {gigaViewerProduct} from '../../shared/gigaviewer/pages';
import {webryLocation} from './definition';

export const changed = () => Error('Sunday Webry 目录或阅读协议已变化，请回源确认后重试。');
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw changed();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw changed();
  return value.trim();
}
export function id(value: unknown): string {
  const result = text(value, 25);
  if (!/^[1-9]\d*$/.test(result)) throw changed();
  return result;
}
export function count(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw changed();
  return value;
}
export function location(url: string) {
  const loc = webryLocation(new URL(url));
  if (!loc) throw changed();
  return loc;
}
export async function request(context: SourceNetworkContext, url: string, options?: Parameters<SourceNetworkContext['request']>[1]) {
  context.signal?.throwIfAborted();
  const raw = await context.request(url, options);
  context.signal?.throwIfAborted();
  return raw;
}
export function json(raw: string): unknown {
  try {return JSON.parse(raw);} catch {throw changed();}
}
export function episodeData(raw: string) {
  const scripts = [...raw.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)]
    .map(match => attributes(match[0].slice(0, match[0].indexOf('>') + 1))).filter(attrs => attrs.id === 'episode-json');
  if (scripts.length !== 1) throw changed();
  return json(text(scripts[0]['data-value'], 4_000_000));
}
export function parseEpisode(value: unknown, url: string) {
  const loc = location(url), product = gigaViewerProduct(value, loc.episode, url => webryLocation(url)?.episode), series = object(product.series);
  const episode = loc.episode, seriesId = id(series.id);
  if (loc.series && loc.series !== seriesId) throw changed();
  return {episode, series: seriesId, title: text(series.title), chapter: text(product.title), product};
}
export function parseReader(raw: string, url: string) {
  const reader = parseEpisode(episodeData(raw), url);
  const canonical = tags(raw, 'link').filter(attrs => attrs.rel === 'canonical');
  if (canonical.length !== 1 || location(canonical[0].href).episode !== reader.episode) throw changed();
  return reader;
}
/** Unwrap only the source's explicit series artwork; never accept arbitrary proxy targets. */
export function coverUrl(value: unknown, series?: string) {
  let url = new URL(text(value, 8192));
  if (url.origin === 'https://cdn-scissors.gigaviewer.com') {
    const encoded = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    url = new URL(decodeURIComponent(encoded));
  }
  if (url.origin !== 'https://cdn-img.www.sunday-webry.com' || url.username || url.password ||
      !/^\/public\/series-thumbnail\/([1-9]\d{0,24})-[a-f\d]+$/.test(url.pathname)) throw changed();
  const found = /^\/public\/series-thumbnail\/(\d+)-/.exec(url.pathname)![1];
  if (series && series !== found) throw changed();
  return {url: url.href, series: found};
}
export function pageUrl(value: unknown) {
  const url = new URL(text(value, 8192));
  if (url.origin !== 'https://cdn-img.www.sunday-webry.com' || url.username || url.password ||
      !/^\/public\/page\/(?:\d+\/)?[1-9]\d*-[a-f\d]+$/.test(url.pathname)) throw changed();
  return url.href;
}
