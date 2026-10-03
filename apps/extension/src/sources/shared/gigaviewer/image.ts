import type {SourceImageAdapter} from '../../contracts/image';
import {protocolChanged} from './pages';

export function bakuDimensions(value: string, prefix = 'gigaviewer-baku') {
  const [kind, w, h, extra] = value.split(':');
  const width = Number(w), height = Number(h);
  if (kind !== prefix || extra !== undefined || !/^\d+$/.test(w ?? '') || !/^\d+$/.test(h ?? '') ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw protocolChanged();
  return {width, height};
}

/** GigaViewer baku transposes a 4x4 grid of tiles rounded down to multiples of 8. */
export async function decodeBaku(blob: Blob, expected?: {width: number; height: number}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(blob, {colorSpaceConversion: 'none'});
  let canvas: OffscreenCanvas | undefined;
  try {
    signal?.throwIfAborted();
    const {width, height} = bitmap;
    bakuDimensions(`gigaviewer-baku:${width}:${height}`);
    if (expected && (expected.width !== width || expected.height !== height)) throw protocolChanged();
    canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('图片还原不可用。');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0); // Preserve the right/bottom remainder strips.
    const w = Math.floor(width / 32) * 8, h = Math.floor(height / 32) * 8;
    if (w && h) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
      ctx.drawImage(bitmap, x * w, y * h, w, h, y * w, x * h, w, h);
    const result = await canvas.convertToBlob({type: 'image/png'});
    signal?.throwIfAborted();
    return result;
  } finally {
    bitmap.close();
    if (canvas) {canvas.width = 1; canvas.height = 1;}
  }
}

/** HTTP inline targets are emitted only for baku; other formats use document-bound pixels. */
export function gigaViewerImage(pageUrl: (value: unknown) => string, processingPrefix = 'gigaviewer-baku'): SourceImageAdapter {
  return {
    async decode(blob, _headers, processing, signal) {
      signal?.throwIfAborted();
      return processing === undefined ? blob : decodeBaku(blob, bakuDimensions(processing, processingPrefix), signal);
    },
    async decodeInline(blob, _headers, url, signal) {
      signal?.throwIfAborted();
      pageUrl(url);
      return decodeBaku(blob, undefined, signal);
    },
  };
}
