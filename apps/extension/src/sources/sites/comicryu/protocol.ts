import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, comicryuLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'comicryu', name: 'COMIC リュウ', origin, searchPageSize: 24, location: comicryuLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://viewer.comic-ryu.jp' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
