import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, comicpashLocation, episodeUrl, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'comicpash', name: 'Comic PASH', origin, searchPageSize: 12, location: comicpashLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://viewer.comicpash.jp' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
