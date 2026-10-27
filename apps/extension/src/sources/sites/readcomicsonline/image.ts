import type {SourceImageAdapter} from '../../contracts/image';

// Read public CDN originals and covers without an injected source Referer.
export const image: SourceImageAdapter = {readerReferrerPolicy: 'no-referrer'};
