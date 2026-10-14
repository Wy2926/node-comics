import type {SourceImageAdapter} from '../../contracts/image';

// The public reader explicitly uses no-referrer on its original images.
export const image: SourceImageAdapter = {readerReferrerPolicy: 'no-referrer'};
