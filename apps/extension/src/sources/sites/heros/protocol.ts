import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, herosLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'heros', name: "HERO'S Web", origin, searchPageSize: 24, location: herosLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://comicsviewer.heros-web.com' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
