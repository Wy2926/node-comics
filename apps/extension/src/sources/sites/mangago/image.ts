import type {SourceImageAdapter} from '../../contracts/image';
import {origin} from './definition';
import {imageUrl} from './protocol';
import {imageProcessing, tileOrder} from './tiles';

async function decode(blob: Blob, _headers: Headers, processing?: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (processing === undefined) return blob;
  const order = tileOrder(processing), bitmap = await createImageBitmap(blob, {colorSpaceConversion: 'none'});
  try {
    signal?.throwIfAborted();
    const {width, height} = bitmap;
    if (width < 9 || height < 9 || width * height > 64 * 1024 * 1024) throw Error('Mangago 图片尺寸无效。');
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
    if (!ctx) throw Error('图片还原不可用。');
    const w = width / 9, h = height / 9;
    for (const [from, to] of order.entries())
      ctx.drawImage(bitmap, from % 9 * w, Math.floor(from / 9) * h, w, h, to % 9 * w, Math.floor(to / 9) * h, w, h);
    const result = await canvas.convertToBlob({type: 'image/png'});
    signal?.throwIfAborted();
    return result;
  } finally {bitmap.close();}
}
export const image: SourceImageAdapter = {
  headers: {Referer: origin + '/'}, readerReferrerPolicy: 'no-referrer-when-downgrade',
  decode,
  decodeInline: (blob, headers, url, signal) => decode(blob, headers, imageProcessing(imageUrl(url)), signal),
};
