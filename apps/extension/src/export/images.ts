/** Decode one page at a time; keep archive JPEG/PNG/WebP bytes unchanged. */
export async function exportImage(blob: Blob, pdf = false): Promise<{blob: Blob; extension: string; width: number; height: number}> {
  const bitmap = await createImageBitmap(blob);
  try {
    const {width, height} = bitmap;
    if (!width || !height || width * height > 32_000_000) throw Error('单页超过 3200 万像素，请缩小该图片后重试。');
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const extension = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg'
      : bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? 'png'
      : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' ? 'webp' : undefined;
    if (!pdf && extension) return {blob, extension, width, height};
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
    if (!ctx) throw Error('浏览器无法创建图片画布。');
    if (pdf) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
    ctx.drawImage(bitmap, 0, 0);
    try {
      return {blob: await canvas.convertToBlob({type: pdf ? 'image/jpeg' : 'image/png', quality: 0.95}), extension: pdf ? 'jpg' : 'png', width, height};
    } finally { canvas.width = canvas.height = 1; }
  } finally { bitmap.close(); }
}
