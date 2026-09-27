import type {DiscoveredPage} from '../../contracts/source';
import {changed, count, object, pageUrl, parseEpisode} from './protocol';

export function parsePages(value: unknown, url: string) {
  const reader = parseEpisode(value, url), rawStructure = reader.product.pageStructure;
  if (!rawStructure) throw Error('Sunday Webry 未提供可读取的正文，请在源站确认公开范围或访问状态。');
  const structure = object(rawStructure), rows = structure.pages;
  if (!Array.isArray(rows) || !rows.length || rows.length > 1600 ||
      !['rtl', 'ltr', 'ttb'].includes(String(structure.readingDirection)) ||
      ![undefined, null, '', 'usagi', 'baku'].includes(structure.choJuGiga as string)) throw changed();
  const items: DiscoveredPage[] = [];
  for (const [index, value] of rows.entries()) {
    const row = object(value);
    if (row.type !== 'main') {
      if (!['link', 'other', 'backMatter'].includes(String(row.type))) throw changed();
      continue;
    }
    const width = count(row.width, 20000), height = count(row.height, 20000), src = pageUrl(row.src);
    if (!width || !height || width * height > 60_000_000 || items.length >= 1500) throw changed();
    items.push({id: 'page-' + index, order: items.length, width, height,
      resource: {kind: 'http', url: src, ...(structure.choJuGiga === 'baku' ? {processing: `webry-baku:${width}:${height}`} : {})}});
  }
  if (!items.length) throw changed();
  return {url, adapter: 'sundaywebry', title: reader.chapter, direction: structure.readingDirection === 'rtl' ? 'rtl' as const : 'ltr' as const,
    discoveryComplete: true, knownTotal: items.length, note: '', items};
}
