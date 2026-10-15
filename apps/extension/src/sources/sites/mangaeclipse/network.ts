import {createMadaraNetwork} from '../../shared/madara/network';
import {madaraImageUrl} from '../../shared/madara/image';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, definition, eclipseLocation, origin} from './definition';

export const {network, parseCatalog, parsePages} = createMadaraNetwork({
  id: definition.id, name: definition.name, origin, direction: 'ltr', reader: 'catalog-select',
  search: 'ajax', searchPageSize: 12,
  location: eclipseLocation, catalogKey, catalogUrl, chapterKey, chapterUrl,
  imageUrl: value => madaraImageUrl(origin, value),
});
