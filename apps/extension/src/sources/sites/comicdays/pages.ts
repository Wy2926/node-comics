import {gigaViewerPages, gigaViewerProduct, protocolChanged} from '../../shared/gigaviewer/pages';
import {comicDaysEpisode} from './definition';
import {pageUrl} from './urls';

export function parsePages(value: unknown, url: string) {
  const episode = comicDaysEpisode(new URL(url));
  if (!episode) throw protocolChanged();
  const product = gigaViewerProduct(value, episode, comicDaysEpisode);
  const {items, direction} = gigaViewerPages(product.pageStructure, pageUrl);
  return {url, adapter: 'comicdays', title: typeof product.title === 'string' ? product.title : '', direction,
    discoveryComplete: true, knownTotal: items.length, note: '', items};
}
