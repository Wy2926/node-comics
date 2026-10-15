import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, asacomiLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'asacomi', name: 'アサコミ', origin, searchPageSize: 24, location: asacomiLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://viewer.asacomi.jp' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
