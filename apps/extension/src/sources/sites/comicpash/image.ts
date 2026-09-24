import type {SourceImageAdapter} from '../../contracts/image';
import {decodeImage} from './images';
export const image: SourceImageAdapter = {decode: decodeImage};
