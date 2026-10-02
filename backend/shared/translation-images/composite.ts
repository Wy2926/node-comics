import {bitmapPng, type PngPatch} from './png';

// An encoding working-set budget, not an image admission limit. Larger pages use
// the bounded scanline encoder instead of allocating another full-page surface.
const canvasPixels = 64 * 1024 * 1024;
const webpEdge = 16383, jpegEdge = 65535;
const displayQuality = 0.95;

function opaque(context: OffscreenCanvasRenderingContext2D, width: number, height: number) {
  for (let y = 0; y < height; y += 512) for (let x = 0; x < width; x += 2048) {
    const data = context.getImageData(x, y, Math.min(2048, width - x), Math.min(512, height - y)).data;
    for (let at = 3; at < data.length; at += 4) if (data[at] !== 255) return false;
  }
  return true;
}

/** A complete display/cache image; input bytes, hashes and remote artifacts never change. */
export async function compositeImage(base: ImageBitmap, patches: PngPatch[], sourceMime: string): Promise<Blob> {
  const {width, height} = base, edge = Math.max(width, height);
  let canvas: OffscreenCanvas | undefined;
  try {
    if (edge <= jpegEdge && width * height <= canvasPixels) {
      canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', {colorSpace: 'srgb'});
      if (context) {
        context.imageSmoothingEnabled = false;
        context.drawImage(base, 0, 0);
        context.globalCompositeOperation = 'source-atop';
        for (const patch of patches) {
          let owned: ImageBitmap | undefined;
          try {
            const bitmap = 'bitmap' in patch ? patch.bitmap : (owned = await createImageBitmap(patch.blob));
            if (bitmap.width !== patch.width || bitmap.height !== patch.height) throw Error('Invalid tile dimensions');
            context.drawImage(bitmap, patch.x, patch.y);
          } finally { owned?.close(); }
        }
        // JPEG input is opaque, and source-atop preserves its alpha. Other long
        // sources need an actual alpha check; never silently flatten transparency.
        const type = edge <= webpEdge ? 'image/webp'
          : sourceMime === 'image/jpeg' || opaque(context, width, height) ? 'image/jpeg' : 'image/png';
        try {
          const output = await canvas.convertToBlob({type, quality: displayQuality});
          // Browsers without this encoder may legitimately return PNG instead.
          if (output.size && (output.type === type || output.type === 'image/png')) return output;
        } catch { /* Native encoder/surface limits differ by browser. Stream the same pixels below. */ }
      }
    }
  } finally { if (canvas) canvas.width = canvas.height = 1; }
  return bitmapPng(base, patches);
}
