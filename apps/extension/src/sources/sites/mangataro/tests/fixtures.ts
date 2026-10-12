export const workUrl = 'https://mangataro.org/manga/sample';
export const readerUrl = 'https://mangataro.org/read/sample/ch1-11';
export const cover = 'https://mangataro.org/content/media/manga-7-cover-123.jpg';
export const image = 'https://cdn.example.test/storage/chapters/sample/001.webp';
export const workHtml = () => `<link rel="canonical" href="${workUrl}"><body data-manga-id="7">
  <button class="add-to-library-btn" data-manga-id="7" data-manga-url="${workUrl}"
    data-manga-title="Sample &amp; Book" data-manga-cover="${cover}"></button>
  <div class="chapter-list" data-manga-id="7"></div></body>`;
export const readerHtml = () => `<link rel="canonical" href="${readerUrl}"><body data-manga-id="7" data-chapter-id="11" data-chapter-number="1">
  <a id="manga-info-link" href="${workUrl}">Sample</a>
  <div id="reader-media" data-manga-type="Manga" data-chapter-title="Sample Chapter 1"></div></body>`;
export const chapter = (id = 11, number = '1', extra = {}) => ({id: String(id), chapter: number, title: 'First', chapter_type: 'media',
  language: 'en', group_name: null, url: `https://mangataro.org/read/sample/ch${number.replace('.', '-')}-${id}`, ...extra});
export const batch = (chapters: unknown[] = [chapter()], extra = {}) => JSON.stringify({success: true, total: chapters.length,
  offset: 0, limit: 500, has_more: false, chapters, ...extra});
export const pagesBody = (extra = {}) => JSON.stringify({success: true, chapter_id: 11, chapter_type: 'media', total: 2, images: [image, image], ...extra});
export const hit = (extra = {}) => ({id: '7', title: 'Sample', url: workUrl, cover, type: 'Manga', ...extra});
