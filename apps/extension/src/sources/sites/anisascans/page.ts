import {createMadaraWork} from '../../shared/madara/work';
import {catalogKey, catalogUrl, definition, mangaLocation} from './definition';

export const describeWork = createMadaraWork({id: definition.id, location: mangaLocation, catalogKey, catalogUrl});
