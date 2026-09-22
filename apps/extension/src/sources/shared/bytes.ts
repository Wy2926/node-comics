import { msg } from '../../i18n/runtime';
export const maxInlineBytes = 40 * 1024 * 1024;
export async function imageDataUrl(blob: Blob) {
  if (blob.size > maxInlineBytes) throw Error(msg('图片超过 40 MB 限制，原图已保留。'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384)
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}
