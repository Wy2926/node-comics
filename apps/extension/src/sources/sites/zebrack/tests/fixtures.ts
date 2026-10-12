import {encode} from '../../../shared/protobuf';

type Field = [number, number | string | Uint8Array];
export const workUrl = 'https://zebrack-comic.shueisha.co.jp/title/9';
export const readerUrl = workUrl + '/chapter/2231/viewer';
export const imageUrl = 'https://asset.zebrack-comic.com/title/9/chapter/2231/page/non_webp/default/100.jpg';
export const recipe = 'zebrack-xor:' + '01'.repeat(64);
export const artwork = 'https://asset.zebrack-comic.com/title/9/volume_thumbnail/100.jpg';
const merge = (base: Field[], override: Field[]) => encode(...base.filter(([key]) => !override.some(([other]) => key === other)), ...override);
export const chapter = (chapterId = 2231, status = 0, extra: Field[] = []) => merge([
  [1, chapterId], [2, 9], [3, `第${chapterId}話`], [11, status], [12, status === 0 ? 0 : 30],
], extra);
export const chapters = (rows = [chapter(), chapter(2232, 4)], extra: Field[] = []) => merge([
  [1, 9], [7, 'Fixture Manga'], [4, encode([2, 7], ...rows.map(row => [3, row] as Field))],
  [5, encode([1, '単行本目次'], [2, encode([1, 'Fixture Manga 1'], [2, 2231])])],
], extra);
export const detail = (extra: Field[] = []) => encode([21, merge([
  [1, 9], [2, 'Fixture Manga'], [11, encode([1, artwork])], [12, 1],
], extra)]);
export const imagePage = (extra: Field[] = []) => encode([1, merge([[1, imageUrl + '?drm_key=fixture&expires=1'], [2, '01'.repeat(64)]], extra)]);
export const viewer = (pages = [imagePage(), imagePage([[1, imageUrl.replace('100.jpg', '101.jpg')]])], extra: Field[] = []) => merge([
  ...pages.map(page => [1, page] as Field), [3, 9], [4, 2231], [5, 'Chapter fixture'], [10, encode([1, 9])],
], extra);
export const searchRow = (id = 9, extra: Field[] = []) => merge([
  [1, artwork.replace('/9/', `/${id}/`)], [2, `garaku://title_detail?titleId=${id}`], [3, 'Fixture Manga'],
], extra);
export const search = (rows = [searchRow()]) => encode([3, 'Search result'], ...rows.map(row => [1, row] as Field));
