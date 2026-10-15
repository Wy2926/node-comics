import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, comicrideLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'comicride', name: 'Comic RIDE / ライコミ', origin, searchPageSize: 24, location: comicrideLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://viewer.comicride.jp' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
