/** Storage IDs can predate a chapter's current catalog identity (including zszj copies). */
export function dm5ImageUrl(value: string): {url: URL; chapterId: string} {
  const url = new URL(value), path = /^\/(?:zszj\/)?\d+\/\d+\/([1-9]\d*)\/[^/]+$/.exec(url.pathname);
  const ids = url.searchParams.getAll('cid');
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cdndm5.com') || url.username || url.password || url.port ||
      url.hash || !path || ids.length > 1 || ids.length === 1 && !/^[1-9]\d*$/.test(ids[0]))
    throw Error('DM5 图片地址无效。');
  // Signed URLs identify the current reader chapter; the storage directory need not match it.
  return {url, chapterId: ids[0] ?? path[1]};
}
