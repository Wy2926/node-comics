import {msg} from '../../../i18n/runtime';
import type {SourceNetwork} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceEntry} from '../../contracts/source';
import {sourceCover} from '../../shared/cover';
import {mangaCopyLocation} from './definition';
import {search} from './search';

const invalid = () => Error(msg('目录未完整加载，请打开来源页处理后重试。'));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 180): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();
  return value.trim();
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 10000) throw invalid();
  return Number(value);
}
function entities(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (whole, key: string) => {
    if (key.startsWith('#')) {
      const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return ({amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' '} as Record<string, string>)[key.toLowerCase()];
  });
}
function attribute(tag: string, name: string) {
  const match = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(["\x27])([\\s\\S]*?)\\1', 'i').exec(tag);
  return match ? entities(match[2]) : undefined;
}

/** The worker has no DOM. Parse inert metadata and the literal ccz value only;
 * never fetch or execute the site's packed directory renderer. */
function detail(html: string, url: string) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const secrets = [...clean.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => !/\bsrc\s*=/i.test(match[1]))
    .flatMap(match => [...match[2].matchAll(/\bvar\s+ccz\s*=\s*(["'])([^"'\\\r\n]*)\1\s*;/g)].map(value => value[2]));
  if (secrets.length !== 1) throw invalid();
  const inert = clean.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const divs = [...inert.matchAll(/<div\b([^>]*)>/gi)];
  const section = (name: string) => divs.filter(match => attribute(match[1], 'class')?.split(/\s+/).includes(name));
  const [right, duplicate] = section('comicParticulars-title-right');
  if (!right || duplicate) throw invalid();
  const heading = /<h6\b[^>]*>([\s\S]*?)<\/h6\s*>/i.exec(inert.slice(right.index! + right[0].length));
  const title = text(entities((heading?.[1] ?? '').replace(/<[^>]*>/g, '')).trim(), 300);
  const left = section('comicParticulars-title-left');
  if (left.length > 1) throw invalid();
  const artwork = left[0] && left[0].index! < right.index!
    ? /<img\b([^>]*)>/i.exec(inert.slice(left[0].index!, right.index!)) : null;
  const cover = artwork ? sourceCover(attribute(artwork[1], 'data-src'), url) ?? sourceCover(attribute(artwork[1], 'src'), url) : undefined;
  return {title, cover, secret: secrets[0]};
}

/** Same wire format as the public renderer: 16 UTF-8 IV characters + AES-CBC hex. */
async function decode(response: string, secret: string) {
  try {
    const result = object(JSON.parse(response));
    if (result.code !== 200 || typeof result.results !== 'string') throw invalid();
    const wire = result.results, rawKey = new TextEncoder().encode(secret);
    const iv = new TextEncoder().encode(wire.slice(0, 16)), hex = wire.slice(16);
    if (![16, 24, 32].includes(rawKey.length) || iv.length !== 16 || !hex.length || hex.length > 8 * 1024 * 1024 ||
      hex.length % 32 || !/^[\da-f]+$/i.test(hex)) throw invalid();
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['decrypt']);
    const bytes = Uint8Array.from(hex.match(/../g)!, pair => parseInt(pair, 16));
    const plaintext = await crypto.subtle.decrypt({name: 'AES-CBC', iv}, key, bytes);
    return object(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(plaintext)));
  } catch { throw invalid(); }
}

function directory(data: Record<string, unknown>, slug: string, url: string, metadata: ReturnType<typeof detail>): SourceCatalogSnapshot {
  const build = object(data.build), sourceGroups = Object.entries(object(data.groups));
  if (build.path_word !== slug || !Array.isArray(build.type) || !build.type.length || build.type.length > 100 ||
    !sourceGroups.length || sourceGroups.length > 1000) throw invalid();
  const types = new Map<number, string>();
  for (const item of build.type) {
    const type = object(item), id = count(type.id), name = text(type.name);
    if (types.has(id)) throw invalid();
    types.set(id, name);
  }
  const id = 'mangacopy:' + slug, entries = new Map<string, SourceEntry>();
  const groups = sourceGroups.map(([groupId, value]) => {
    const group = object(value), title = text(group.name), total = count(group.count);
    if (text(groupId) !== group.path_word || !Array.isArray(group.chapters) || !total || group.chapters.length !== total) throw invalid();
    const entryIds: string[] = [], seen = new Set<string>();
    for (const [order, value] of group.chapters.entries()) {
      const chapter = object(value), remoteId = text(chapter.id), title = text(chapter.name), type = types.get(count(chapter.type));
      const chapterUrl = new URL('/comic/' + slug + '/chapter/' + remoteId, url).href;
      if (!type || mangaCopyLocation(chapterUrl)?.chapterId !== remoteId || seen.has(remoteId)) throw invalid();
      seen.add(remoteId);
      const entryId = id + ':' + remoteId, existing = entries.get(entryId);
      if (existing) {
        if (existing.title !== title || existing.rawTypes[0] !== type) throw invalid();
        existing.groupIds.push(groupId);
      } else {
        entries.set(entryId, {id: entryId, catalogId: id, remoteId, url: chapterUrl, title,
          groupIds: [groupId], rawTypes: [type], order, related: false});
      }
      if (entries.size > 10000) throw invalid();
      entryIds.push(entryId);
    }
    const last = object(group.last_chapter);
    if (last.comic_path_word !== slug || last.group_path_word !== groupId || last.count !== total ||
      !seen.has(text(last.uuid))) throw invalid();
    return {id: groupId, title, entryIds, complete: true};
  });
  return {id, sourceId: 'mangacopy', url, title: metadata.title, cover: metadata.cover,
    observedAt: Date.now(), complete: true, note: '', groups,
    entries: [...entries.values()].map(entry => ({...entry,
      sequenceId: entry.groupIds.length === 1 ? entry.groupIds[0] + ':' + entry.rawTypes[0] : undefined})),
    defaultEntryId: groups.find(group => group.id === 'default')?.entryIds[0]};
}

export const network: SourceNetwork = {
  search,
  async catalog(url, context) {
    const loc = mangaCopyLocation(url);
    if (!loc || loc.chapterId) throw Error(msg('请从 MangaCopy 漫画详情页导入作品。'));
    const canonical = new URL('/comic/' + loc.slug, url).href;
    context.signal?.throwIfAborted();
    const metadata = detail(await context.request(canonical), canonical);
    context.signal?.throwIfAborted();
    const response = await context.request(new URL('/comicdetail/' + loc.slug + '/chapters', canonical).href);
    context.signal?.throwIfAborted();
    const data = await decode(response, metadata.secret);
    context.signal?.throwIfAborted();
    return directory(data, loc.slug, canonical, metadata);
  },
};
