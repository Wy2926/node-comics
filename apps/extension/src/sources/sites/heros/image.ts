import type {SourceImageAdapter} from '../../contracts/image';
import {decodeImage} from '../../shared/comici/images';

export const image: SourceImageAdapter = {decode: decodeImage};
