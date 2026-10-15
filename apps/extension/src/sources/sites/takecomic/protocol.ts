import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, takecomicLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'takecomic', name: 'TakeComic / 竹コミ！', origin, searchPageSize: 24, location: takecomicLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://viewer.takecomic.jp' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
