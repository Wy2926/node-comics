import type {SourceImageAdapter} from '../../contracts/image';
import {decodeImage} from '../../shared/comici/images';
export const image: SourceImageAdapter = {safariTransport:'public-native',decode: decodeImage};
