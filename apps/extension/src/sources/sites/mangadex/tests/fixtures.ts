export const mangaId = '42f40118-dff5-4f23-acbf-e54e89f026bd';
export const otherMangaId = '00000000-0000-4000-8000-000000000002';
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export function chapter(n = 1, language = 'en', number: string | null = '1', volume: string | null = '1') {
  return {id: uuid(n), type: 'chapter', attributes: {title: 'Fixture chapter', volume, chapter: number,
    translatedLanguage: language, pages: 2, externalUrl: null as string | null, isUnavailable: false},
    relationships: [{id: mangaId, type: 'manga'}, {id: uuid(800), type: 'scanlation_group', attributes: {name: 'Fixture group'}}]};
}
export function manga() {
  return {result: 'ok', response: 'entity', data: {id: mangaId, type: 'manga',
    attributes: {title: {'ja-ro': 'Fixture manga'}, originalLanguage: 'ja'},
    relationships: [{id: uuid(900), type: 'cover_art', attributes: {fileName: uuid(901) + '.jpg'}}]}};
}
export function aggregate(chapters = [chapter()]) {
  const volumes: Record<string, {volume: string; count: number; chapters: Record<string, {chapter: string; id: string; others: string[]; count: number}>}> = {};
  for (const row of chapters) {
    const volume = row.attributes.volume ?? 'none', number = row.attributes.chapter ?? 'none';
    const group = volumes[volume] ??= {volume, count: 0, chapters: {}};
    group.count++;
    if (group.chapters[number]) {group.chapters[number].others.push(row.id); group.chapters[number].count++;}
    else group.chapters[number] = {chapter: number, id: row.id, others: [], count: 1};
  }
  return {result: 'ok', volumes};
}
export function atHome(data = ['1-image.png', '2-image.jpg'], baseUrl = 'https://fixture.mangadex.network') {
  return {result: 'ok', baseUrl, chapter: {hash: '0123456789abcdef0123456789abcdef', data, dataSaver: []}};
}
export function requestFixture(rows = [chapter()]) {
  return async (target: string) => {
    const url = new URL(target);
    if (url.pathname.endsWith('/feed')) {
      const offset = Number(url.searchParams.get('offset'));
      return JSON.stringify({result: 'ok', response: 'collection', limit: 100, offset, total: rows.length, data: rows.slice(offset, offset + 100)});
    }
    if (url.pathname.endsWith('/aggregate')) return JSON.stringify(aggregate(rows));
    if (url.pathname.startsWith('/chapter/')) return JSON.stringify({result: 'ok', response: 'entity', data: rows.find(row => row.id === url.pathname.split('/').at(-1))});
    if (url.pathname.startsWith('/at-home/')) return JSON.stringify(atHome());
    return JSON.stringify(manga());
  };
}
