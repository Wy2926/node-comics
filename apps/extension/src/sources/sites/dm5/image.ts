import type {SourceImageAdapter} from '../../contracts/image';
import {chapterUrl} from './definition';
import {dm5ImageUrl} from './image-url';
export const image: SourceImageAdapter = {
  coverHeaders: {referer: 'https://www.dm5.com/'},
  headers(value) {
    return {referer: chapterUrl(dm5ImageUrl(value).chapterId)};
  },
};
