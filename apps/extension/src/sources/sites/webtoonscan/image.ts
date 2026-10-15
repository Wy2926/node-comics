import type {SourceImageAdapter} from '../../contracts/image';
import {madaraImageUrl} from '../../shared/madara/image';
import {origin} from './definition';

/** Only images inside an ownership-validated Madara cover/reader are passed here. */
export const imageUrl = (value: unknown) => madaraImageUrl(origin, value);

export const image: SourceImageAdapter = {coverTransport: 'page'};
