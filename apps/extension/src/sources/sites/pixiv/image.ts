import type {SourceImageAdapter} from '../../contracts/image';
// Public pximg originals require a Pixiv Referer; Safari cannot apply DNR to its own fetch.
export const image: SourceImageAdapter = {safariTransport:'public-native'};
