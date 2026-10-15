import type {ComiciSite} from '../../shared/comici/config';
import {catalogUrl, episodeUrl, youngchampionLocation, origin} from './definition';

export const protocol: ComiciSite = {
  id: 'youngchampion', name: 'Young Champion / ヤンチャンWeb', origin, searchPageSize: 24, location: youngchampionLocation, catalogUrl, episodeUrl,
  imageUrl: (url, viewerId) => url.origin === 'https://viewer.youngchampion.jp' && !url.username && !url.password &&
    url.pathname.startsWith(`/book/${viewerId}/`) && !url.pathname.endsWith('/'),
};
