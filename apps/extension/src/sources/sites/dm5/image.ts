import type {SourceImageAdapter} from '../../contracts/image';
import {chapterUrl} from './definition';
export const image: SourceImageAdapter = {
  coverHeaders: {referer: 'https://www.dm5.com/'},
  headers(value) {
    const url = new URL(value), path = /^\/\d+\/\d+\/([1-9]\d*)\/[^/]+$/.exec(url.pathname);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.cdndm5.com') || url.username || url.password || url.port || !path)
      throw Error('DM5 图片地址无效。');
    return {referer: chapterUrl(path[1])};
  },
};
