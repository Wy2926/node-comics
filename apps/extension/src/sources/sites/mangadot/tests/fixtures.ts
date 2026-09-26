export function metadata() {return {manga: {id: 7, title: 'Multilingual fixture', photo: '/uploads/cover.webp'}, total_chapters: 2, total_volumes: 1};}
export function chapter(id = 1, lang = 'en', number = 1, source = 'user') {
  return {id, chapter_number: number, chapter_title: 'Chapter ' + number, volume_number: null, language: lang,
    source, date_added: '2026-06-01 00:00:00+00', page_count: 3, groups: [{name: 'Fixture Group'}]};
}
export function chapters() {return [chapter(2, 'fr'), chapter(1, 'en'), chapter(3, 'es'), chapter(4, 'en', 2), chapter(1, 'en', 1, 'scraper')];}
export function volumes() {return [{id: 1, volume_number: 1, language: 'en', date_added: '2026-06-02 00:00:00+00', page_count: 3, groups: []}];}
export function images(id = 1, source = 'user', kind = 'chapter') {
  return {chapter: {id, manga_id: 7, chapter_number: '1.00', chapter_title: 'First', volume_number: '1.00', page_count: 3,
    ...(source === 'user' ? {type: kind, status: 'approved'} : {})}, manga: {id: 7, title: 'Multilingual fixture'},
    ...(source === 'user' ? {source, type: kind} : {}), images: [
      {url: '/chapters/manga_7/first/001.webp', w: 800, h: 1200},
      {url: '/chapters/manga_7/first/002.webp', w: 800, h: 1200},
      {url: '/chapters/manga_7/first/002.webp', w: 800, h: 1200},
    ]};
}
export function searchResult() {return {query: 'fixture', manga_list: [{id: 7, title: 'Multilingual fixture', photo: '/uploads/cover.webp', country_of_origin: 'JP'}],
  pagination: {current_page: 1, total_pages: 1, total_results: 1, per_page: 12, next_cursor: null as string | null}};}
