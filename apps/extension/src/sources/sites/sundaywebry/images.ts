import {changed} from './protocol';

export function parseProcessing(value: string) {
  const match = /^webry-baku:(\d+):(\d+)$/.exec(value);
  if (!match) throw changed();
  const width = Number(match[1]), height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw changed();
  return {width, height};
}
/** GigaViewer baku transposes a 4x4 grid of tiles rounded down to multiples of 8. */
export async function decodeBaku(blob: Blob, expected?: {width: number; height: number}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(blob, {colorSpaceConversion: 'none'});
  try {
    signal?.throwIfAborted();
    const {width, height} = bitmap;
    parseProcessing(`webry-baku:${width}:${height}`);
    if (expected && (expected.width !== width || expected.height !== height)) throw changed();
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
    if (!ctx) throw Error('图片还原不可用。');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0); // The right and bottom remainder strips are not scrambled.
    const w = Math.floor(width / 32) * 8, h = Math.floor(height / 32) * 8;
    if (w && h) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
      ctx.drawImage(bitmap, x * w, y * h, w, h, y * w, x * h, w, h);
    const result = await canvas.convertToBlob({type: 'image/png'});
    signal?.throwIfAborted();
    return result;
  } finally {bitmap.close();}
}
