export const origin = 'https://weloma.net', work = '0AbCd', chapter = 'eFg12';
export const url = origin + '/m/' + work, reader = origin + '/c/' + chapter;
export const image = 'https://weloma-fixture.test/images/page.jpg', cover = 'https://weloma-fixture.test/images/cover.jpg';
export const encoded = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
export const identity = (target: string) => `<script>if (ok) { window.location.href='${target}'; }</script>`;
export const chapterRow = (id: string, title: string) => `<a href="/c/${id}" title="${title}"><li>
  <div class="chapter-name text-truncate">${title}</div><div class="chapter-time">1 day ago</div></li></a>`;
export const catalogHtml = () => `${identity(url)}<div class="info-cover"><img class="thumbnail" src="${cover}"></div>
  <ul class="manga-info"><h3 data-enc="${encoded('サンプル & Book')}"></h3></ul>
  <ul class="list-chapters at-series">${chapterRow('eNext', 'Chapter 2.5')}${chapterRow(chapter, 'Chapter 1')}</ul>`;
export const readerHtml = (images = [image, image]) => `${identity(reader)}
  <ol class="breadcrumb"><li><a href="/">Home</a></li><li><a href="/m/${work}">Sample</a></li>
  <li><a href="/c/${chapter}">Chapter 1</a></li></ol><h1 data-enc="${encoded('サンプル Chapter 1')}"></h1>
  <div class="chapter-content"><div id="chapter-images">${images.map(src =>
    `<img class='chapter-img lazyload' src='data:image/gif;base64,R0lGODlh' data-img='${encoded(src)}'><br>`).join('')}
  <div id="ad-slik"></div><script>const promo = '<img src="https://ads.invalid/promo.png">';</script></div></div>
  <img src="https://ads.invalid/recommendation.png">`;
export const searchCard = (id = work) => `<div class="thumb-item-flow" id="bm_${id}"><div class="thumb-wrapper">
  <a href="/m/${id}"><div class="a6-ratio"><div class="content img-in-ratio" style="background-image: url('${cover}');"></div></div></a>
  <div class="thumb-detail"><div class="chapter-title"><a href="/c/${chapter}">Last chapter: 1</a></div></div></div>
  <div class="series-title"><a href="/m/${id}">Sample &amp; Book</a></div></div>`;
export const searchHtml = (count = 1, page = 1, more = false) => `<div id="history">${Array.from({length: count}, (_, i) => searchCard(work + i)).join('')}</div>
  <ul class="pagination pagination-v4">${count ? `<li><a class="active">${page}</a></li>` : ''}${more
    ? `<li><a href="/l/0Next">${page + 1}</a></li><li><a href="/l/0Last">9</a></li>` : ''}</ul>`;
