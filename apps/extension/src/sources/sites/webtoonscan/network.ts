import type {SourceNetwork} from '../../contracts/network';
import {createMadaraNetwork} from '../../shared/madara/network';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, definition, origin, webtoonLocation} from './definition';
import {imageUrl} from './image';

const shared = createMadaraNetwork({
  id: definition.id, name: definition.name, origin, direction: 'ltr', searchPageSize: 20,
  location: webtoonLocation, catalogKey, catalogUrl, chapterKey, chapterUrl, imageUrl,
});
export const {parseCatalog, parsePages, parseSearch, searchUrl} = shared;
export const network = {
  ...shared.network,
  search: shared.network.search!,
  searchPage: shared.searchUrl,
  pageTransport: ['catalog', 'pages'],
} satisfies SourceNetwork;
