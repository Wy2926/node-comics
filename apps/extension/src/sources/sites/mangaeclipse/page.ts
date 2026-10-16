import {createMadaraWork} from '../../shared/madara/work';
import {catalogKey, catalogUrl, definition, eclipseLocation} from './definition';

export const describeWork = createMadaraWork({
  id: definition.id, reader: 'catalog-select', location: eclipseLocation, catalogKey, catalogUrl,
});
