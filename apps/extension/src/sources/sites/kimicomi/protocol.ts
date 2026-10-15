import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, kimicomiLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'kimicomi', name: 'KimiComi / キミコミ', origin, searchPageSize: 24, location: kimicomiLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://viewer.kimicomi.com' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
