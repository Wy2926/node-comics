export function parseProcessing(value: string) {
  const match = /^comici-v1:(\d+):(\d+):([\d,]+)$/.exec(value);
  if (!match) throw Error('Comic PASH 图片还原协议无效。');
  const width = Number(match[1]), height = Number(match[2]), order = match[3].split(',').map(Number);
  if (width < 4 || height < 4 || width > 20000 || height > 20000 || width * height > 60_000_000 ||
    order.length !== 16 || new Set(order).size !== 16 || order.some(n => !Number.isInteger(n) || n < 0 || n > 15))
    throw Error('Comic PASH 图片还原参数无效。');
  return {width, height, order};
}
/** Comici's 4×4 permutation enumerates both source and destination tiles column-first. */
export async function decodeImage(blob: Blob, _headers: Headers, processing?: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (processing === undefined) return blob; // Inline HTTP images, if any, are already displayed originals.
  const {width, height, order} = parseProcessing(processing);
  const bitmap = await createImageBitmap(blob, {colorSpaceConversion: 'none'});
  try {
    signal?.throwIfAborted();
    if (bitmap.width !== width || bitmap.height !== height) throw Error('Comic PASH 原图尺寸与清单不符。');
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
    if (!ctx) throw Error('图片还原不可用。');
    // Match the source viewer: only complete tiles are painted; remainder pixels stay transparent.
    const w = Math.floor(width / 4), h = Math.floor(height / 4);
    for (const [to, from] of order.entries())
      ctx.drawImage(bitmap, Math.floor(from / 4) * w, from % 4 * h, w, h, Math.floor(to / 4) * w, to % 4 * h, w, h);
    const result = await canvas.convertToBlob({type: 'image/png'});
    signal?.throwIfAborted();
    return result;
  } finally { bitmap.close(); }
}
