import type {SourceNetworkContext} from '../../contracts/network';
import {attributes, inertHtml, tags} from '../html';
import type {GigaViewerIdentity} from './identity';
import {gigaViewerPages, gigaViewerProduct, protocolChanged as changed} from './pages';

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
export function json(raw: string): unknown {
  try {return JSON.parse(raw);} catch {throw changed();}
}
export async function request(context: SourceNetworkContext, url: string, options?: Parameters<SourceNetworkContext['request']>[1]) {
  context.signal?.throwIfAborted();
  const raw = await context.request(url, options);
  context.signal?.throwIfAborted();
  return raw;
}

/** Only public episode products; no volume/magazine acquisition or unlock actions. */
export function gigaViewerSerialProtocol(identity: GigaViewerIdentity, urls: {
  pageUrl(value: unknown): string;
  coverUrl(value: unknown, series?: string): {url: string; series: string};
}) {
  function location(url: string) {
    const loc = identity.location(new URL(url));
    if (!loc) throw changed();
    return loc;
  }
  function product(value: unknown, url: string) {
    const loc = location(url);
    if (loc.catalog) throw changed();
    const result = gigaViewerProduct(value, loc.episode, identity.episode);
    const series = object(result.series);
    if (loc.series && id(series.id) !== loc.series) throw changed();
    return result;
  }
  function parseReader(raw: string, url: string) {
    const loc = location(url), html = inertHtml(raw);
    const canonical = tags(html, 'link').filter(attrs => attrs.rel === 'canonical');
    if (canonical.length !== 1) throw changed();
    const episode = identity.episode(new URL(canonical[0].href));
    if (!episode || !loc.catalog && loc.episode !== episode) throw changed();
    const scripts = [...raw.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)]
      .map(match => attributes(match[0].slice(0, match[0].indexOf('>') + 1))).filter(attrs => attrs.id === 'episode-json');
    if (scripts.length !== 1) throw changed();
    const parsed = product(json(text(scripts[0]['data-value'], 4_000_000)), identity.episodeUrl(episode, loc.series));
    const series = object(parsed.series), seriesId = id(series.id);
    return {episode, series: seriesId, title: text(series.title), product: parsed};
  }
  function parsePages(value: unknown, url: string) {
    const parsed = product(value, url);
    const {items, direction} = gigaViewerPages(parsed.pageStructure, urls.pageUrl);
    return {url, adapter: identity.sourceId, title: typeof parsed.title === 'string' ? parsed.title : '', direction,
      discoveryComplete: true, knownTotal: items.length, note: '', items};
  }
  return {...identity, ...urls, location, parseReader, parsePages};
}
export type GigaViewerSerialProtocol = ReturnType<typeof gigaViewerSerialProtocol>;

/** Same verified asset layout, with an explicit site-owned CDN policy. */
export function gigaViewerAssetUrls(origin: string) {
  function asset(value: unknown, pattern: RegExp) {
    const url = new URL(text(value, 8192));
    if (url.origin !== origin || url.username || url.password || !pattern.test(url.pathname)) throw changed();
    return url;
  }
  const pageUrl = (value: unknown) => asset(value, /^\/public\/page\/(?:(?:filtered\/)?\d+\/)?[1-9]\d*-[a-f\d]+$/).href;
  function coverUrl(value: unknown, series?: string) {
    let url = new URL(text(value, 8192));
    if (url.origin === 'https://cdn-scissors.gigaviewer.com' && !url.username && !url.password)
      url = new URL(decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1)));
    url = asset(url.href, /^\/public\/series-thumbnail\/([1-9]\d{0,24})-[a-f\d]+$/);
    const found = /^\/public\/series-thumbnail\/(\d+)-/.exec(url.pathname)![1];
    if (series && series !== found) throw changed();
    return {url: url.href, series: found};
  }
  return {pageUrl, coverUrl};
}
