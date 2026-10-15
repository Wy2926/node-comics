import {origin} from '../definition';
export {origin};
export const slug = 'fixture-warrior', url = origin + '/manga/' + slug + '/', reader = url + 'capitulo-1/';
export const artwork = 'https://monopolyscan-images.test/cover.png', image = 'https://monopolyscan-images.test/page.png';
export function catalogHtml() {
  return `<body class="single-wp-manga postid-321"><link rel="canonical" href="${url}"><h1>Guerrero de prueba</h1>
    <div class="summary_image"><a href="${url}"><img data-src="${artwork}"></a></div>
    <div id="manga-chapters-holder" data-id="321"></div></body>`;
}
export function chaptersHtml() {
  return `<div class="listing-chapters_wrap"><ul class="main version-chap no-volumn">
    <li class="wp-manga-chapter"><a href="${url}capitulo-2_abc123/">Capítulo 2</a></li>
    <li class="wp-manga-chapter"><a href="${reader}">Capítulo 1</a></li></ul></div>`;
}
export function readerHtml() {
  const holder = '<div class="chapter-selection chapters_selectbox_holder" data-manga="321" data-chapter="capitulo-1" data-type="manga" data-style="list" data-vol="0"></div>';
  return `<body class="reading-manga postid-321"><link rel="canonical" href="${reader}">
    <h1 id="chapter-heading">Capítulo 1</h1><div class="top-bar">${holder}</div>
    <div id="manga-reading-nav-head" data-id="321" data-chapter="capitulo-1">${holder}</div>
    <div class="reading-content"><input id="wp-manga-current-chap" data-id="1001" value="capitulo-1">
      <div class="page-break"><img id="image-0" class="wp-manga-chapter-img" data-src="${image}"></div>
      <div class="page-break"><img id="image-1" class="wp-manga-chapter-img" data-src="${image}"></div></div>
    <div id="manga-reading-nav-foot" data-id="321">${holder}</div></body>`;
}
export function searchHtml(count: number, done = false, offset = 0) {
  return Array.from({length: count}, (_, index) => {
    const work = `${origin}/manga/fixture-${index + offset}/`;
    return `<div class="row c-tabs-item__content"><div class="tab-thumb"><a href="${work}"><img src="${artwork}"></a></div>
      <div class="post-title"><a href="${work}">Guerrero ${index + offset}</a></div></div>`;
  }).join('') + (done ? '<div class="invi no-posts"><!-- --></div>' : '');
}
