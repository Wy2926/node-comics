import {origin} from '../definition';
export {origin};
export const slug = 'fixture-book', title = 'Mangasushi fixture';
export const url = origin + '/manga/' + slug + '/', reader = url + 'chapter-1/';
export const artwork = 'https://mangasushi-images.test/cover.png', image = 'https://mangasushi-images.test/page.png';
export function catalogHtml() {
  return `<body class="single-wp-manga postid-123"><link rel="canonical" href="${url}"><h1>${title}</h1>
    <div class="summary_image"><a href="${url}"><img data-src="${artwork}" src="placeholder.gif"></a></div>
    <div id="manga-chapters-holder" data-id="123"><i class="spinner"></i></div></body>`;
}
export function chaptersHtml(chapters = ['chapter-2.5', 'chapter-1', '0']) {
  return `<div class="listing-chapters_wrap show-more"><ul class="main version-chap no-volumn">${chapters.map(chapter =>
    `<li class="wp-manga-chapter"><a href="${url}${chapter}/">${chapter}</a></li>`).join('')}</ul>
    <div class="c-chapter-readmore"><span>Show more</span></div></div>`;
}
export function readerHtml(images = [image, image], chapter = 'chapter-1') {
  const target = url + chapter + '/';
  const holder = `<div class="chapter-selection chapters_selectbox_holder" data-manga="123" data-chapter="${chapter}" data-type="manga" data-style="list" data-vol="0"></div>`;
  return `<body class="reading-manga postid-123"><link rel="canonical" href="${target}">
    <h1 id="chapter-heading">${title} - ${chapter}</h1>
    <div id="manga-reading-nav-head" data-id="123" data-chapter="${chapter}">${holder}</div>
    <div class="reading-content"><input id="wp-manga-current-chap" data-id="1001" value="${chapter}">
    ${images.map((source, order) => `<div class="page-break"><img id="image-${order}" class="wp-manga-chapter-img" data-src="${source}"></div>`).join('')}</div>
    <div id="manga-reading-nav-foot" data-id="123">${holder}</div></body>`;
}
