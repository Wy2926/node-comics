import {createMangaThemesiaNetwork} from '../../shared/mangathemesia/network';
import {safeImageUrl} from '../../shared/urls';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, location, origin} from './definition';

export const {network, parseCatalog, parsePages, readerInfo, parseSearch, searchUrl} = createMangaThemesiaNetwork({
  id: 'lagoonscans', name: 'Lagoon Scans', origin, direction: 'ltr', location, catalogKey, catalogUrl, chapterKey, chapterUrl,
  searchUrl: (query, page) => origin + (page === 1 ? '/' : `/page/${page}/`) + '?' + new URLSearchParams({s: query}),
  emptySearchText: 'Not Found',
  imageUrl(value) {
    const url = typeof value === 'string' ? safeImageUrl(value, origin) : null;
    if (!url || new URL(url).hash) throw Error('Lagoon Scans 图片地址无效。');
    return url;
  },
});
