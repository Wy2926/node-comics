import {catalogUrl, origin} from '../definition';

export const workUrl = catalogUrl('gt-42'), readerUrl = workUrl + 'chapter-1/';
export const detail = `<body class="single postid-42"><link rel="canonical" href="${workUrl}">
  <h1>Unrelated heading</h1><h1 class="summary-title">테스트 작품</h1>
  <div class="manga-summary-cover"><a href="${workUrl}"><img src="https://images.test/gt-42/cover.jpg?v=123"></a></div>
  <div id="manga-chapters-holder" data-id="42"></div></body>`;
export const chapters = `<a href="#" class="btn-reverse-order">순서 변경</a><div class="listing-chapters_wrap"><ul class="main version-chap no-volumn">
  <li class="wp-manga-chapter"><a href="${workUrl}2/"><span class="up-badge-inline">UP</span>2화</a></li>
  <li class="wp-manga-chapter"><a href="${readerUrl}">1화</a></li></ul></div>`;
export const pages = `<body class="postid-42"><link rel="canonical" href="${readerUrl}"><h1 id="chapter-heading">1화</h1>
  <select class="chapter-select-nav"><option value="${workUrl}2/">2화</option><option value="${readerUrl}" selected>1화</option></select>
  <div class="reading-content"><input id="wp-manga-current-chap" data-id="123" value="chapter-1">
  <img id="image-0" class="wp-manga-chapter-img" data-src="https://images.test/gt-42/1/01.jpg">
  <img id="image-1" class="wp-manga-chapter-img" src="https://images.test/gt-42/1/01.jpg"></div></body>`;
export const card = (id: number) => `<a class="card" href="${catalogUrl('gt-' + id)}"><div class="thumb">
  <img class="platform-icon" src="/icon.png"><img src="https://images.test/gt-${id}/cover_123.jpg"></div>
  <div class="info"><div class="subject">테스트 ${id}</div></div></a>`;
export function searchHtml(count = 2, page = 1, hasNext = false) {
  return `<div class="card-grid">${Array.from({length: count}, (_, i) => card((page - 1) * 63 + i + 1)).join('')}</div>` +
    (hasNext || page > 1 ? `<div class="pagination"><a class="page-numbers current" href="${origin}/?q=test&pg=${page}">${page}</a>` +
      (hasNext ? `<a class="page-numbers" href="/?q=test&pg=${page + 1}">다음 &raquo;</a>` : '') + '</div>' : '');
}
