export const origin = 'https://mangaeclipse.com', slug = 'fixture-book';
export const catalog = `${origin}/manga/${slug}/`, first = '1-trap-part-one', latest = 'chapter-14';
export const reader = catalog + first + '/', cover = origin + '/wp-content/uploads/fixture-cover.png';
export const image = origin + '/wp-content/uploads/WP-manga/data/fixture/page.jpg';
export const chapterIds = [latest, 'chapter-2.5', first];
export const label = (chapter: string) => chapter === first ? '1 - Trap Part One' : chapter;
export function catalogHtml(ids = chapterIds) {
  return `<link rel="canonical" href="${catalog}"><h1><span class="manga-title-badges hot">HOT</span>Fixture &amp; Book</h1>
    <div class="summary_image"><a href="${catalog}"><img src="data:image/gif;base64,placeholder" data-src="${cover}"></a></div>
    <div class="listing-chapters_wrap show-more"><ul class="main version-chap">${ids.map(chapter =>
      `<li class="wp-manga-chapter"><a href="${catalog}${chapter}/">${label(chapter)}</a></li>`).join('')}</ul></div>`;
}
export function readerHtml(images = [image, image], chapter = first) {
  const menu = `<select class="single-chapter-select">${chapterIds.map(id =>
    `<option value="${id}" data-redirect="${catalog}${id}/"${id === chapter ? ' selected="selected"' : ''}>${label(id)}</option>`).join('')}</select>`;
  return `<link rel="canonical" href="${catalog}"><title>Untrusted document title</title>${menu}${menu}${menu}
    <div class="reading-content"><input id="wp-manga-current-chap" data-id="42" value="${chapter}">${images.map((url, order) =>
      `<div class="page-break"><img class="wp-manga-chapter-img" id="image-${order}" data-src="\n\t${url}\n"></div>`).join('')}</div>`;
}
