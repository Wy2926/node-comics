import {catalogUrl, chapterUrl, origin} from '../definition';
export const slug = '契約-fixture', url = catalogUrl(slug);
export const reader = chapterUrl({slug, language: 'ja', chapter: '1'});
export const image = 'https://sv1.freeimgmg.online/files/7/11/1.webp';
export const cover = 'https://mgoimg.view47.com/thumb/300/upload/2026/10/abcdef.jpeg';
export function row(number: string, language = 'ja', remoteId = number.replace('.', '') + '1') {
  return `<li class="item reading-item chapter-item" data-id="${remoteId}" data-number="${number}">
    <a class="item-link" href="${chapterUrl({slug, language, chapter: number})}"><span class="name"><strong>第${number}話</strong>: Title &amp; ${number}</span>
    <span class="item-read">読む</span></a><div class="clearfix"></div></li>`;
}
export function catalogHtml() {
  return `<link rel="canonical" href="${url}"><div class="anis-content"><div class="anisc-poster"><img data-src="${cover}"></div>
    <div class="anisc-detail"><h2 class="manga-name">Work &amp; Name</h2><div class="manga-buttons"></div></div></div>
    <section id="chapters-list"><a class="lang-item" data-type="chap" data-code="ja">[JA] Japanese (3 章)</a>
    <a class="lang-item" data-type="chap" data-code="en">[EN] English (1 章)</a>
    <ul class="lang-chapters" id="ja-chaps">${row('2', 'ja', '21')}${row('1.5', 'ja', '15')}${row('1', 'ja', '11')}</ul>
    <ul class="lang-chapters" id="en-chaps">${row('1', 'en', '31')}</ul></section>
    <section><a href="${origin}/read/unrelated/ja/chapter-1-raw/">Advertisement</a></section>`;
}
export function readerHtml() {
  return `<link rel="canonical" href="${reader}"><a class="hr-manga" href="${url}"><h2 class="manga-name">Work &amp; Name</h2></a>
    <ul class="lang-chapters" id="ja-chapters">${row('2', 'ja', '21')}${row('1', 'ja', '11')}</ul>
    <div id="images-content"></div><script>throw Error('never execute');</script>`;
}
export function pagesHtml(images = [image, image]) {
  return `<div id="vertical-content"><div class="shuffled"><img src="https://ads.example/ad.jpg"></div>
    ${images.map((src, index) => `<div class="iv-card loader shuffled"><img class="image-vertical lazyload" alt="${index}"
      src="data:image/gif;base64,placeholder" data-src="${src}"></div>`).join('')}</div>`;
}
export const pagesJson = (html = pagesHtml()) => JSON.stringify({status: 1, html});
export function searchHtml(query = 'Work', next = false) {
  return `<link rel="canonical" href="/?q=${encodeURIComponent(query)}"><div id="main-content"><h1 class="cat-heading">${query}</h1>
    <div class="manga_list-sbs"><div class="mls-wrap"><div class="flw-item"><a class="manga-poster" href="${url}">
    <span class="tick-lang">JA</span><img data-src="${cover}"></a><div class="manga-detail"><h3 class="manga-name"><a href="${url}">Work &amp; Name</a></h3>
    <div class="chapter"><a href="${reader}">第1話</a></div></div></div></div></div>
    <div class="pre-pagination">${next ? `<a href="/?q=${encodeURIComponent(query)}&amp;page=2">Next</a>` : ''}</div></div>`;
}
