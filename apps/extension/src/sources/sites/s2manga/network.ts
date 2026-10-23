import {createMadaraNetwork} from '../../shared/madara/network';
import {madaraImageUrl} from '../../shared/madara/image';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, definition, mangaLocation, origin} from './definition';

export const {network, parseCatalog, parsePages} = createMadaraNetwork({
  id: definition.id, name: definition.name, origin, direction: 'ltr',
  reader: 'ajax-select', search: 'ajax', searchPageSize: 12,
  location: mangaLocation, catalogKey, catalogUrl, chapterKey, chapterUrl,
  imageUrl: value => madaraImageUrl(origin, value),
});
