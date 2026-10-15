import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, mangabangLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'mangabang', name: 'MangaBang Comics / マンガBANGコミックス', origin, searchPageSize: 24, location: mangabangLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://comicsviewer.manga-bang.com' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
