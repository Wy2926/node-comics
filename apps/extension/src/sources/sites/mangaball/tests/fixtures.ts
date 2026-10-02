export const titleId = '0123456789abcdef01234567';
export const otherTitleId = '0123456789abcdef01234568';
export const chapterId = '123456789abcdef012345678';
export const secondChapterId = '123456789abcdef012345679';
export const thirdChapterId = '123456789abcdef012345670';
export const image = `https://chikorita.red-and-blue.net/storage/${titleId}/0/1/example/en/${chapterId}-001.webp`;
export const row = (key = chapterId, number: number | null = 1, lang = 'en') => ({id: key, _id: key, title_id: titleId,
  number, chapter_number: number, lang, name: 'Release title', volume: 0, group: {name: 'Public group'}, status: 'published'});
export const group = (number: number | null = 1, releases = [row()]) => ({chapter_number: number, title: 'Chapter ' + number, releases});
export const success = <T>(data: T) => ({status: 'success', code: 200, data});
export const title = (total = 2) => success({id: titleId, _id: titleId, name: 'Fixture work', chapters_count: total,
  image: {cover: {path: titleId + '\\cover_123.jpg'}}, availableTranslatedLanguages: ['en', 'zh-cn'], author: [{name: 'Author'}]});
export const groups = () => [group(1, [row(), row(secondChapterId, 1, 'es')]), group(2, [row(thirdChapterId, 2, 'zh-cn')])];
export const listing = (values = groups(), total = values.length, page = 1) => ({...success(values.flatMap(group => group.releases).reverse()),
  grouped_data: values, pagination: {page, limit: 100, total, total_pages: Math.max(1, Math.ceil(total / 100))}});
export const reader = (pages: unknown[] = [image, image]) => success({chapter: {...row(), pages}, title: {id: titleId, name: 'Fixture work'}});
export const searchPage = (values: unknown[] = [(title().data)], total = values.length, page = 1) => ({...success(values),
  pagination: {page, limit: 20, total, total_pages: Math.max(1, Math.ceil(total / 20))}});
