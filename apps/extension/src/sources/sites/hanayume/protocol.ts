import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, hanayumeLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'hanayume', name: 'Hana To Yume+ / 花とゆめ＋', origin, searchPageSize: 24, location: hanayumeLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://viewer.hanayume.com' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
