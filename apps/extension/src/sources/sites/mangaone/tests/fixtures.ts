import {encode} from '../../../shared/protobuf';
export type Field = [number, number | string | Uint8Array];
export const merge = (base: Field[], extra: Field[]) => encode(...base.filter(([key]) => !extra.some(([other]) => key === other)), ...extra);
export const workUrl = 'https://manga-one.com/manga/9/chapter/first';
export const readerUrl = 'https://manga-one.com/manga/9/chapter/11';
export const artwork = 'https://app.manga-one.com/secure/123/webp/title_vertical_thumb/91.webp?hash=fixture';
export const imageUrl = 'https://app.manga-one.com/secure/123/webp/manga_page_low/11/1.webp.enc?hash=fixture';
export const recipe = `mangaone-aes:${'01'.repeat(32)}:${'02'.repeat(16)}`;
export const title = (work = 9, extra: Field[] = []) => encode([1, merge([[1, work], [2, 'Fixture Manga'], [16, artwork]], extra)]);
export const detail = (work = 9, extra: Field[] = []) => encode([1, title(work, extra)]);
export const chapter = (chapterId = 11, badge = 1, extra: Field[] = []) => merge([
  [1, chapterId], [2, `第${chapterId}話`], [3, 'Subtitle'], [12, badge], [14, 1], [16, new Uint8Array()],
], extra);
export const chapters = (rows = [chapter(), chapter(12, 0)], page = 1, total = rows.length, extra: Field[] = []) => encode([1, merge([
  ...rows.map(row => [1, row] as Field), [2, encode([1, page], [2, Math.ceil(total / 100)])],
  [3, (page - 1) * 100 + 1], [4, Math.min(total, page * 100)], [5, total],
], extra)]);
export const imagePage = (extra: Field[] = []) => encode([1, merge([[1, imageUrl], [2, 720], [3, 1020]], extra)]);
export const viewer = (pages = [imagePage(), imagePage()], extra: Field[] = []) => merge([
  ...pages.map(page => [1, page] as Field), [3, '01'.repeat(32)], [4, '02'.repeat(16)], [5, title()], [7, chapter()],
], extra);
export const search = (works = [9]) => encode(...works.map(work => [3, encode([1, title(work)])] as Field));
