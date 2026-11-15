import type {SourceImageAdapter} from '../../contracts/image';
import {origin} from './definition';

export const image: SourceImageAdapter = {
  headers: {Referer: origin + '/'},
  coverHeaders: {},
  readerReferrerPolicy: 'no-referrer-when-downgrade',
};
