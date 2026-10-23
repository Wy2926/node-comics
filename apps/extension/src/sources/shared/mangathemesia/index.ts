import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {attributes, hasClass, inertHtml, tags, textContent} from '../html';
import type {MangaThemesiaSite} from './config';
import {mangaThemesiaHtml} from './html';
import {mangaThemesiaSearch} from './search';
import {legacyReaderData} from './legacy-reader';

/** The verified static catalog and public ts_reader JSON protocol; no source scripts execute. */
export function createMangaThemesiaParsers(site: MangaThemesiaSite) {
  const legacy = site.reader === 'legacy-ready', mirrored = legacy || site.reader === 'minimal';
  const helpers = mangaThemesiaHtml(site);
  const {one, text, location, regions, byClass, byId, canonical, image} = helpers;
  function document(html: string, section = 'postbody') {
    const safe = inertHtml(html);
    if (!/<\/body\s*>\s*<\/html\s*>\s*$/i.test(safe)) throw Error(`${site.name} 页面未完整返回。`);
    return {safe, main: byClass(safe, 'div', section)};
  }
  function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
    const loc = location(url), {safe, main} = document(html);
    if (!loc.catalogSlug || loc.chapterSlug) throw Error(`请使用 ${site.name} 作品详情页链接。`);
    canonical(safe, loc);
    const title = text(textContent(byClass(main, 'h1', 'entry-title')));
    const cover = {url: image(byClass(main, 'div', 'thumb'))};
    // The same theme also uses bxcl for a hidden local reading-history panel.
    const box = one(regions(main, 'div', a => !!hasClass(a, 'bxcl') && !!hasClass(a, 'epcheck')), '章节目录').body;
    const list = byId(box, 'div', 'chapterlist');
    const rows = regions(list, 'li', () => true);
    if (!rows.length || rows.length > 10000 || tags(list, 'li').length !== rows.length || tags(list, 'ul').length !== 1 ||
      tags(list, 'a').length !== rows.reduce((count, row) => count + tags(row.body, 'a').length, 0) ||
      /<(?:nav|button|select)\b|\b(?:pagination|hpage|load-more|loadmore|data-page|data-total)\b/i.test(box))
      throw Error(`${site.name} 目录不完整或存在未支持的分页。`);
    const id = site.catalogKey(loc.catalogSlug), seen = new Set<string>();
    // Native previous/next follows the reverse of the complete newest-first chapter list.
    const entries = rows.reverse().map((row, order) => {
      const link = one(regions(byClass(row.body, 'div', 'eph-num'), 'a', () => true), '章节链接');
      if (tags(row.body, 'a').length !== 1) throw Error(`${site.name} 目录含未识别的额外链接。`);
      const target = location(text(link.attrs.href));
      if (!target.chapterSlug || target.catalogSlug && target.catalogSlug !== loc.catalogSlug || seen.has(target.chapterSlug))
        throw Error(`${site.name} 章节重复或作品归属错误。`);
      if (link.attrs['data-bs-target'] || link.attrs['data-toggle'] || /\b(?:locked|paid|premium)\b/i.test(row.attrs.class ?? ''))
        throw Error(`${site.name} 目录包含未支持的受保护章节。`);
      seen.add(target.chapterSlug);
      return {id: site.chapterKey(target.chapterSlug), catalogId: id, remoteId: target.chapterSlug,
        url: site.chapterUrl(target.chapterSlug, loc.catalogSlug), title: text(textContent(byClass(link.body, 'span', 'chapternum'))),
        order, groupIds: ['chapters'], rawTypes: [], related: false, sequenceId: id};
    });
    return {id, sourceId: site.id, url: site.catalogUrl(loc.catalogSlug), title, cover, complete: true,
      observedAt: Date.now(), note: '', groups: [{id: 'chapters', title: 'Chapters', complete: true, entryIds: entries.map(e => e.id)}],
      entries, defaultEntryId: entries[0].id};
  }
  function readerInfo(html: string, url: string) {
    const loc = location(url), {safe, main} = document(html, 'chapterbody');
    if (!loc.chapterSlug) throw Error(`${site.name} 章节地址无效。`);
    canonical(safe, loc);
    const parent = location(one(tags(byClass(main, 'div', 'allc'), 'a'), '所属作品').href);
    if (!parent.catalogSlug || parent.chapterSlug || loc.catalogSlug && loc.catalogSlug !== parent.catalogSlug)
      throw Error(`${site.name} 章节作品归属错误。`);
    return {catalogSlug: parent.catalogSlug, catalogUrl: site.catalogUrl(parent.catalogSlug),
      title: text(textContent(byClass(main, 'h1', 'entry-title'))), main};
  }
  function readerData(html: string): Record<string, unknown> {
    const active = html.replace(/<!--[\s\S]*?-->|<(template|noscript|style|textarea|title|xmp|iframe|noembed|noframes)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    const scripts = [...active.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    const calls = scripts.flatMap(script => {
      const attrs = attributes('<script ' + script[1] + '>');
      if (/(?:^|\s)src(?:\s|=|$)/i.test(script[1]) ||
        /(?:^|\s)type(?:\s|=|$)/i.test(script[1]) && !['text/javascript', 'application/javascript'].includes(attrs.type)) return [];
      const body = script[2].trim();
      if (legacy) {
        const value = legacyReaderData(body);
        return value === undefined ? [] : [value];
      }
      if (!/^ts_reader\s*\.\s*run\s*\(/.test(body)) return [];
      const match = /^ts_reader\s*\.\s*run\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/.exec(body);
      if (!match) throw Error(`${site.name} 正文不是受支持的静态 JSON。`);
      try {return [JSON.parse(match[1]) as unknown];} catch {throw Error(`${site.name} 正文数据无效。`);}
    });
    const value = one(calls, '正文数据');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${site.name} 正文数据无效。`);
    return value as Record<string, unknown>;
  }
  function parsePages(html: string, url: string): SourceSnapshot {
    const info = readerInfo(html, url), data = readerData(html);
    // These flags describe access; an images field alone is not authorization to read a protected release.
    const accessValid = legacy
      ? ['protected', 'is_novel', 'unlock_token', 'post_id'].every(key => !Object.hasOwn(data, key))
      : data.protected === false && data.is_novel === false && data.unlock_token === null &&
        Number.isSafeInteger(data.post_id) && (data.post_id as number) > 0;
    if (!accessValid || data.mode !== 'full' || data.contentmode !== (site.reader === 'minimal' ? 'minimal' : 'advanced'))
      throw Error(`${site.name} 正文受保护、尚不可用或读取协议已变化。`);
    const viewer = byId(info.main, 'div', 'readerarea').replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '');
    if (/<(?:iframe|canvas|video)\b/i.test(viewer) || !mirrored && /<img\b/i.test(viewer))
      throw Error(`${site.name} 正文包含未支持的混合读取通道。`);
    if (!Array.isArray(data.sources) || data.sources.length !== 1) throw Error(`${site.name} 正文图片源缺失或存在未支持的多源变体。`);
    const source = data.sources[0];
    if (!source || typeof source !== 'object' || typeof source.source !== 'string' || !source.source ||
      (legacy ? typeof data.defaultSource !== 'string' || !data.defaultSource : source.source !== data.defaultSource) ||
      !Array.isArray(source.images) || !source.images.length || source.images.length > 1500)
      throw Error(`${site.name} 未提供完整正文图片清单。`);
    // Repeated URLs are distinct ordered page slots; never filter a missing or invalid page.
    const items = source.images.map((value: unknown, order: number) => ({id: 'page-' + order, order, width: 0, height: 0,
      resource: {kind: 'http' as const, url: site.imageUrl(text(value, 8192))}}));
    if (mirrored) {
      // The verified theme variants supply the same complete public list twice. Require agreement;
      // a missing/truncated/changed DOM list is not a fallback and must not silently lose pages.
      const mirrors = tags(viewer, 'img');
      if (mirrors.length !== items.length || mirrors.some((attrs, i) => site.imageUrl(text(attrs.src, 8192)) !== items[i].resource.url))
        throw Error(`${site.name} 正文 HTML 与 JSON 图片清单不一致。`);
    }
    return {url, adapter: site.id, title: info.title, direction: site.direction, note: '', discoveryComplete: true,
      knownTotal: items.length, items};
  }
  return {parseCatalog, readerInfo, parsePages, ...mangaThemesiaSearch(site, helpers, document)};
}
