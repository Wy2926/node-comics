import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, origin} from './definition';
import {blocks, changed, coverUrl, imageUrl, label, location, one, ownership, text} from './html';
import {search} from './search';

export function parseCatalog(raw: string, url: string): SourceCatalogSnapshot {
  const html = inertHtml(raw), loc = ownership(html, url);
  if (loc.chapter !== undefined) throw changed();
  const first = blocks(html, 'div', 'id', 'chapter-items');
  const remaining = blocks(html, 'div', 'id', 'chapters_other_list');
  const buttons = blocks(html, 'button', 'id', 'button_show_all_chatper');
  if (first.length > 1 || remaining.length > 1 || buttons.length > 1 || remaining.length !== buttons.length) throw changed();
  let list: string;
  if (first.length) list = first[0] + (remaining[0] ?? '');
  else {
    if (remaining.length || buttons.length) throw changed();
    // At most 24 chapters: the source renders only its complete, newest-first list.
    const box = one(blocks(html, 'div', 'class', 'l-box').filter(body => tags(body, 'a').some(a => hasClass(a, 'comics-chapters__item'))));
    if (textContent(one(blocks(box, 'div', 'class', 'section-title'))) !== '最新章节') throw changed();
    list = one(blocks(box, 'div', 'class', 'pure-g'));
  }
  const links = [...list.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
  const total = buttons.length ? /^查看全部(\d+)章节$/.exec(textContent(buttons[0]))?.[1] : String(links.length);
  if (!total || !links.length || Number(total) !== links.length || links.length > 10000 || !buttons.length && links.length > 24 || tags(list, 'a').length !== links.length) throw changed();
  if (!first.length) links.reverse();
  const id = catalogKey(loc.comic), seen = new Set<string>();
  const entries = links.map((match, order) => {
    const attrs = attributes(' ' + match[1]), target = location(new URL(text(attrs.href), origin).href);
    const entryId = chapterKey(target);
    if (!hasClass(attrs, 'comics-chapters__item') || target.chapter === undefined || target.comic !== loc.comic || target.part !== 1 || seen.has(entryId)) throw changed();
    seen.add(entryId);
    return {id: entryId, catalogId: id, remoteId: `${target.section}_${target.chapter}`, url: chapterUrl(target),
      title: text(textContent(match[2])), groupIds: ['chapters'], rawTypes: [], order, related: false,
      sequenceId: `${id}:section:${target.section}`};
  });
  const title = label(html, 'h1', 'comics-detail__title');
  const info = one(blocks(html, 'div', 'class', 'de-info__box'));
  const cover = coverUrl(tags(info, 'amp-img')[0]?.src);
  return {id, sourceId: 'baozimh', url: catalogUrl(loc.comic), title, cover,
    observedAt: Date.now(), complete: true, note: '', entries,
    groups: [{id: 'chapters', title: '章节目录', entryIds: entries.map(e => e.id), complete: true}], defaultEntryId: entries[0]?.id};
}
export function parsePart(raw: string, url: string) {
  const html = inertHtml(raw), loc = ownership(html, url);
  if (loc.chapter === undefined) throw changed();
  const header = one(blocks(html, 'div', 'class', 'header'));
  const title = label(header, 'span', 'title'), pagination = /\((\d+)\/(\d+)\)$/.exec(title);
  const total = pagination ? Number(pagination[2]) : 1;
  if (total < loc.part || total > 30 || pagination && Number(pagination[1]) !== loc.part || !pagination && loc.part !== 1) throw changed();
  const body = one(blocks(html, 'ul', 'class', 'comic-contain'));
  const images = tags(body, 'amp-img').filter(a => hasClass(a, 'comic-contain__item'));
  if (!images.length || images.length > 1500) throw changed();
  const seen = new Set<string>();
  const items = images.map((attrs, order) => {
    const id = text(attrs.id), width = Number(attrs.width), height = Number(attrs.height);
    if (!/^chapter-img-\d+-\d+$/.test(id) || seen.has(id) || !Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) throw changed();
    seen.add(id);
    return {id: `part-${loc.part}:${id}`, order, width, height, resource: {kind: 'http' as const, url: imageUrl(text(attrs.src))}};
  });
  const nextLinks = tags(html, 'a').filter(a => a.id === 'next-chapter');
  let next: string | undefined;
  if (loc.part < total) {
    next = text(one(nextLinks).href);
    const target = location(next);
    if (chapterKey(target) !== chapterKey(loc) || target.part !== loc.part + 1 || next !== chapterUrl(loc, target.part)) throw changed();
  } else {
    if (nextLinks.length > 1) throw changed();
    if (nextLinks.length) {
      const target = location(text(nextLinks[0].href));
      if (target.comic !== loc.comic || target.chapter === undefined || chapterKey(target) === chapterKey(loc) || target.part !== 1) throw changed();
    } else if (tags(html, 'a').filter(a => a.id === 'is_last_chapter_a').length !== 1) throw changed();
  }
  return {title: pagination ? title.slice(0, pagination.index).trim() : title, total, next, items};
}
async function request(context: SourceNetworkContext, url: string) {
  context.signal?.throwIfAborted();
  const html = await context.request(url);
  context.signal?.throwIfAborted();
  return html;
}
export const network = {
  search,
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter !== undefined) throw changed();
    const target = catalogUrl(loc.comic);
    return parseCatalog(await request(context, target), target);
  },
  async pages(url, context): Promise<SourceSnapshot> {
    const loc = location(url);
    if (loc.chapter === undefined) throw changed();
    let target: string | undefined = chapterUrl(loc), title = '', total = 0;
    const items: SourceSnapshot['items'] = [];
    for (let part = 1; target; part++) {
      if (part > 30) throw changed();
      const page = parsePart(await request(context, target), target);
      if (part === 1) {title = page.title; total = page.total;}
      if (page.title !== title || page.total !== total || items.length + page.items.length > 1500) throw changed();
      for (const item of page.items) items.push({...item, order: items.length});
      target = page.next;
    }
    return {url, adapter: 'baozimh', title, direction: 'ltr', discoveryComplete: true, knownTotal: items.length, note: '', items};
  },
} satisfies SourceNetwork;
