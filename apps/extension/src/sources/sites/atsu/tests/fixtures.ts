// Small synthetic fixtures following the public Atsumaru API, without copied comic text or image bytes.
export const metadata = () => ({mangaPage: {id: 'Work1', title: 'Fixture work', medium: 'Comic', type: 'Manga',
  poster: {image: 'posters/fixture.jpg'}, totalChapterCount: 2, chapters: chapters().chapters,
  scanlators: [{id: 'Scan1', name: 'First group'}, {id: 'Scan2', name: 'Second group'}]}});
export const chapter = (id: string, index: number, scanlator = 'Scan1') => ({id, scanlationMangaId: scanlator,
  title: 'Chapter ' + (index + 1), index, number: index + 1, pageCount: 3});
export const chapters = () => ({chapters: [chapter('Chap2', 1), chapter('Chap3', 0, 'Scan2'), chapter('Chap1', 0)]});
export const pages = () => ({readChapter: {id: 'Chap1', title: 'Chapter 1', scanlationMangaId: 'Scan1',
  pages: [0, 1, 2].map(number => ({id: 'Chap1-' + number, number, width: 800, height: 1200,
    image: `/static/pages/Work1/Chap1/${number === 2 ? 1 : number}.webp`}))}});
export const hits = () => ({found: 1, page: 1, hits: [{document: {id: 'Work1', title: 'Fixture work', medium: 'Comic',
  authors: ['Fixture author'], poster: '/static/posters/fixture.jpg'}}]});
