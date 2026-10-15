/** Shared syntax policy; callers still own image/CDN authorization and transport. */
export function madaraImageUrl(origin: string, value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value.trim()))
    throw Error('Madara 页面图片数据无效。');
  const url = new URL(value.trim(), origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw Error('Madara 图片地址无效。');
  return url.href;
}
