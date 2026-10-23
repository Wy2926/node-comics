import {createMangaThemesiaNetwork} from '../../shared/mangathemesia/network';
import {safeImageUrl} from '../../shared/urls';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, location, origin} from './definition';

export const {network, parseCatalog, parsePages, searchUrl} = createMangaThemesiaNetwork({
  id: 'asterscans', name: 'Aster Scans', origin, direction: 'ltr', reader: 'legacy-ready',
  location, catalogKey, catalogUrl, chapterKey, chapterUrl,
  searchUrl: (query, page) => origin + (page === 1 ? '/' : `/page/${page}/`) + '?' + new URLSearchParams({s: query}),
  emptySearchText: 'Not Found',
  imageUrl(value) {
    const url = typeof value === 'string' ? safeImageUrl(value, origin) : null;
    if (!url || new URL(url).hash) throw Error('Aster Scans 图片地址无效。');
    return url;
  },
});
