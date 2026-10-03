import {gigaViewerPages} from '../../shared/gigaviewer/pages';
import {pageUrl, parseEpisode} from './protocol';

export function parsePages(value: unknown, url: string) {
  const reader = parseEpisode(value, url), rawStructure = reader.product.pageStructure;
  if (!rawStructure) throw Error('Sunday Webry 未提供可读取的正文，请在源站确认公开范围或访问状态。');
  // Keep the persisted source recipe namespace used by existing Webry manifests.
  const {items, direction} = gigaViewerPages(rawStructure, pageUrl, 'webry-baku');
  return {url, adapter: 'sundaywebry', title: reader.chapter, direction,
    discoveryComplete: true, knownTotal: items.length, note: '', items};
}
