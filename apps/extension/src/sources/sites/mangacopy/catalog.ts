import { msg } from '../../../i18n/runtime';
import type { SourceCatalogSnapshot, SourceEntry, SourceKind } from '../../contracts/source';
import { mangaCopyLocation } from './definition';
export function classify(types: string[], related: boolean): SourceKind {
  return related
    ? 'unclassified'
    : types.includes('卷')
      ? 'publication'
      : types.includes('番外')
        ? 'extra'
        : types.some((t) => t === '話' || t === '话')
          ? 'chapter'
          : 'unclassified';
}
export function discoverMangaCopyCatalog(doc: Document, url: string): SourceCatalogSnapshot {
  const location = mangaCopyLocation(url);
  if (!location || location.chapterId) throw Error(msg('请从 MangaCopy 漫画详情页导入作品。'));
  const id = `mangacopy:${location.slug}`,
    entries = new Map<string, SourceEntry>();
  const tables = [...doc.querySelectorAll('.upLoop > .table-default')];
  let complete = tables.length > 0 && !doc.querySelector('.upLoop .wargin');
  const groups = tables.map((table) => {
    const panel = [...table.querySelectorAll('.tab-pane')].find((p) => p.id.endsWith('全部'));
    const groupId = panel?.id.slice(0, -2) ?? '',
      title = table.previousElementSibling?.textContent?.trim() || groupId;
    const links = [...(panel?.querySelectorAll<HTMLAnchorElement>('a[href*="/chapter/"]') ?? [])];
    // Empty tab panels can be inserted before the asynchronous directory links.
    // Their presence alone does not establish a complete source catalog.
    let valid = !!groupId && links.length > 0;
    const entryIds: string[] = [];
    for (const [order, a] of links.entries()) {
      const href = new URL(a.getAttribute('href') ?? '', url).href,
        loc = mangaCopyLocation(href);
      if (!loc?.chapterId || loc.slug !== location.slug) {
        valid = false;
        continue;
      }
      const entryId = `${id}:${loc.chapterId}`;
      const rawTypes = [...table.querySelectorAll('.tab-pane')]
        .filter(
          (p) =>
            p !== panel &&
            [...p.querySelectorAll('a[href*="/chapter/"]')].some(
              (link) => link.getAttribute('href') === a.getAttribute('href'),
            ),
        )
        .map((p) => p.id.slice(groupId.length));
      const existing = entries.get(entryId);
      if (existing) {
        existing.groupIds = [...new Set([...existing.groupIds, groupId])];
        existing.rawTypes = [...new Set([...existing.rawTypes, ...rawTypes])];
      } else
        entries.set(entryId, {
          id: entryId,
          catalogId: id,
          remoteId: loc.chapterId,
          url: href,
          title: (a.getAttribute('title') || a.textContent || msg('未命名条目')).trim().slice(0, 180),
          groupIds: [groupId],
          rawTypes,
          order,
          related: /同人|其他系列|其它系列/.test(title),
        });
      if (!entryIds.includes(entryId)) entryIds.push(entryId);
    }
    // The site's current renderer inserts every item; pagination only changes display.
    if (!panel || new Set(links.map((a) => a.getAttribute('href'))).size !== entryIds.length) valid = false;
    if (!valid) complete = false;
    return { id: groupId, title, entryIds, complete: valid };
  });
  return {
    id,
    sourceId: 'mangacopy',
    url: new URL('/comic/' + location.slug, url).href,
    title:
      doc.querySelector('.comicParticulars-title-right h6')?.textContent?.trim() ||
      doc.querySelector('h6')?.textContent?.trim() ||
      doc.title.split(' - ')[0],
    observedAt: Date.now(),
    complete,
    note: complete
      ? msg('已读取所有分组及隐藏分页条目。')
      : msg('目录尚未就绪或结构发生变化；只能选择已发现条目。'),
    groups: groups.filter((group) => group.id && group.title),
    entries: [...entries.values()].map((entry) => ({
      ...entry,
      suggestedKind: classify(entry.rawTypes, entry.related),
    })),
  };
}
