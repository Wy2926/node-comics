import type {SourceImageAdapter} from '../../contracts/image';

/** Public viewer's repeating 8-byte XOR transport; no account or paid access is acquired. */
export const image: SourceImageAdapter = {
  async decode(blob, _headers, processing, signal) {
    signal?.throwIfAborted();
    if (processing === undefined) return blob;
    const match = /^comicwalker-xor:([a-f0-9]{16})$/.exec(processing);
    if (!match) throw Error('ComicWalker 图片还原参数无效。');
    const key = Uint8Array.from(match[1].match(/../g)!, byte => parseInt(byte, 16));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    signal?.throwIfAborted();
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i % key.length];
    if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
      String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') throw Error('ComicWalker 图片还原失败。');
    signal?.throwIfAborted(); return new Blob([bytes], {type: 'image/webp'});
  },
};
