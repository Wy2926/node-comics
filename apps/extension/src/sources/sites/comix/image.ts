import type {SourceImageAdapter} from '../../contracts/image';
import {decodeImage} from './images';
export const image:SourceImageAdapter={headers:{referer:'https://comix.to/'},decode:decodeImage};
