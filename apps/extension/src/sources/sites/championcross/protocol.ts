import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, championcrossLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'championcross', name: 'Champion Cross / チャンピオンクロス', origin, searchPageSize: 24, location: championcrossLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://viewer.championcross.jp' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
