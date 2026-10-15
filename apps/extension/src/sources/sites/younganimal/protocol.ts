import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, younganimalLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'younganimal', name: 'Young Animal / ヤングアニマル', origin, searchPageSize: 24, location: younganimalLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://viewer.younganimal.com' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
