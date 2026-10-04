import type {SourceImageAdapter} from '../../contracts/image';
import {decodeImage} from './images';
export const image: SourceImageAdapter = {
  coverTransport: 'page',
  readerReferrerPolicy: 'no-referrer',
  decode: decodeImage,
};
