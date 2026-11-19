import type {SourceImageAdapter} from '../../contracts/image';
import {decodeXorImage} from '../../shared/xor-image';

/** Same repeating 64-byte XOR used by the public viewer; no login or entitlement changes. */
export const image: SourceImageAdapter = {
  async decode(blob, _headers, processing, signal) {
    signal?.throwIfAborted();
    if (processing === undefined) return blob;
    const match = /^zebrack-xor:([a-f\d]{128})$/.exec(processing);
    if (!match) throw Error('Zebrack 图片还原参数无效。');
    return decodeXorImage(blob, match[1], signal);
  },
};
