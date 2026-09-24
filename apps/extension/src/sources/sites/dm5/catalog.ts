import type {SourceCatalogSnapshot, SourceEntry, SourceGroup} from '../../contracts/source';
import {catalogUrl, chapterUrl, dm5Location} from './definition';
import {assignment, attribute, htmlText, positive, scripts, text} from './parsing';
import {sourceCover} from '../../shared/cover';

export function parseCatalog(html: string, url: string): SourceCatalogSnapshot {
  const loc = dm5Location(new URL(url));
  if (!loc?.slug || loc.chapterId) throw Error('请使用 DM5 漫画详情页链接。');
  const data = scripts(html), canonical = new URL(text(assignment(data, 'DM5_COMIC_URL')), url);
  if (dm5Location(canonical)?.slug !== loc.slug || dm5Location(canonical)?.chapterId) throw Error('DM5 漫画归属已变化。');
  positive(assignment(data, 'DM5_COMIC_MID'));
  const sort = assignment(data, 'DM5_COMIC_SORT');
  if (sort !== 1 && sort !== 2) throw Error('DM5 目录排序已变化。');
  const headings = /<div\b[^>]*class=["']detail-list-title["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  if (!headings) throw Error('DM5 未提供可读目录，漫画可能已下架或受访问限制。');
  const id = 'dm5:' + loc.slug, entries: SourceEntry[] = [], groups: SourceGroup[] = [], seen = new Set<string>();
  for (const match of headings.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const groupId = /['"](detail-list-select-\d+)['"]/.exec(attribute(match[1], 'onclick') ?? '')?.[1];
    if (!groupId) continue;
    const heading = /^(.*?)\s*[（(](\d+)[）)]$/.exec(htmlText(match[2]));
    if (!heading || groups.some(g => g.id === groupId)) throw Error('DM5 分类数量无效。');
    const title = text(heading[1]), count = positive(Number(heading[2]), 10000);
    const panels = [...html.matchAll(/<ul\b([^>]*)>([\s\S]*?)<\/ul>/gi)].filter(m => attribute(m[1], 'id') === groupId);
    if (panels.length !== 1) throw Error('DM5 目录分类缺失或重复。');
    const links = [...panels[0][2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
    if (links.length !== count) throw Error('DM5 目录未完整获取，已保留原目录。');
    if (sort === 2) links.reverse();
    const entryIds: string[] = [];
    for (const link of links) {
      const href = new URL(attribute(link[1], 'href') ?? '', canonical), chapter = dm5Location(href);
      if (!chapter?.chapterId || chapter.slug && chapter.slug !== loc.slug || seen.has(chapter.chapterId)) throw Error('DM5 目录包含无效或重复章节。');
      seen.add(chapter.chapterId);
      // Grid and compact lists have different title markup; thumbnail/date text is not a title.
      const label = /<p\b[^>]*class=["']title\s*[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(link[2])?.[1] ?? link[2];
      const title = text(htmlText(label.replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, '')));
      const entryId = 'dm5:chapter:' + chapter.chapterId;
      entries.push({id: entryId, catalogId: id, remoteId: chapter.chapterId,
        url: chapterUrl(chapter.chapterId) + '#nodelane-dm5=' + loc.slug,
        title, groupIds: [groupId], rawTypes: [text(heading[1])], order: entries.length,
        related: false, sequenceId: id + ':' + groupId});
      entryIds.push(entryId);
    }
    groups.push({id: groupId, title, entryIds, complete: true});
  }
  if (!groups.length || !entries.length || entries.length > 10000) throw Error('DM5 未返回完整章节目录。');
  const coverPanel = /<div\b[^>]*class=["']banner_detail_form["'][^>]*>\s*<div\b[^>]*class=["']cover["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  const coverImage = coverPanel && /<img\b([^>]*)>/i.exec(coverPanel)?.[1];
  return {id, sourceId: 'dm5', url: catalogUrl(loc.slug), title: text(assignment(data, 'DM5_COMIC_MNAME')),
    cover: sourceCover(coverImage ? attribute(coverImage, 'src') : undefined, url),
    observedAt: Date.now(), complete: true, note: '', groups, entries, defaultEntryId: entries[0].id};
}
