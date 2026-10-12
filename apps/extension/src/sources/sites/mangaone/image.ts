import type {SourceImageAdapter} from '../../contracts/image';

export const image: SourceImageAdapter = {
  async decode(blob, _headers, processing, signal) {
    signal?.throwIfAborted();
    if (processing === undefined) return blob;
    const match = /^mangaone-aes:([a-f\d]{64}):([a-f\d]{32})$/.exec(processing);
    if (!match) throw Error('Manga One 图片还原参数无效。');
    const hex = (value: string) => Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16));
    const encrypted = await blob.arrayBuffer(); signal?.throwIfAborted();
    const key = await crypto.subtle.importKey('raw', hex(match[1]), 'AES-CBC', false, ['decrypt']);
    const clear = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-CBC', iv: hex(match[2])}, key, encrypted));
    signal?.throwIfAborted();
    const mime = clear[0] === 0xff && clear[1] === 0xd8 && clear[2] === 0xff ? 'image/jpeg'
      : clear[0] === 0x89 && String.fromCharCode(...clear.subarray(1, 8)) === 'PNG\r\n\x1a\n' ? 'image/png'
      : String.fromCharCode(...clear.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...clear.subarray(8, 12)) === 'WEBP' ? 'image/webp' : '';
    if (!mime) throw Error('Manga One 图片还原失败。');
    return new Blob([clear], {type: mime});
  },
};
