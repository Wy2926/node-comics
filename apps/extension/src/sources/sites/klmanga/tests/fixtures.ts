import {catalogUrl, chapterUrl, origin} from '../definition';

export const slug = '契約-fixture-raw-free';
export const url = catalogUrl(slug), reader = chapterUrl({slug, chapter: 'chapter-1'});
export const cover = origin + '/wp-content/uploads/2025/08/fixture.jpg';
export const image = 'https://p1.pubg-img.si:183/d/fixturetoken/merged_Chapter%201.jpg';
export function catalogHtml() {
  return `<link rel="canonical" href="${url}">
    <div class="z-single-mg"><h1 class="name">Work &amp; Name</h1>
    <div class="main-thumb"><img src="${cover}"><p>Work &amp; Name</p></div>
    <p class="font-bold text-uppercase">Chapters</p><div class="chapter-box">
    <h4><a href="${chapterUrl({slug, chapter: 'chapter-7-5'})}"><span>Work &amp; Name 【第7.5話】</span><span class="font-9x text-danger">New</span></a></h4>
    <h4><a href="${reader}"><span>Work &amp; Name 【第1話】</span></a></h4>
    </div><div class="grid-related"><img src="https://evil.test/recommendation.jpg"></div></div>`;
}
export function readerHtml() {
  return `<link rel="canonical" href="${reader}">
    <ol class="breadcrumb"><li><a href="${origin}/">Home</a></li><li><a href="${url}">Work &amp; Name</a></li><li class="active">【第1話】</li></ol>
    <select class="single-chapter-select"><option value="chapter-7-5" data-redirect="${chapterUrl({slug, chapter: 'chapter-7-5'})}">【第7.5話】</option>
    <option selected value="chapter-1" data-redirect="${reader}">【第1話】</option></select>
    <div class="z_content"></div><img src="https://evil.test/advertisement.jpg">
    <script id="custom.js-js-extra">var zing = {"home_url":"${origin}","ajax_url":"${origin}/wp-admin/admin-ajax.php","nonce":"abc1234567"};</script>
    <script>$.ajax({data: {action: 'z_do_ajax', _action: 'decode_images', reading_chapter: 926398, img_index: img_index, content: $('.z_content').html()}});</script>`;
}
export function batch(urls = [image], index = urls.length, going = 0, delay = 0) {
  return JSON.stringify({mes: urls.map(url => `<img src='${url}' data-preload='yes'>`).join(''),
    going, img_index: index, next_timeout: delay});
}
export function searchHtml(query = 'Work & Name', page = 1, next = false) {
  const card = `<div class="entry"><div class="thumb"><a class="thumb" href="${url}"><img src="${cover}"></a>
    <a class="meta-info" href="${reader}">【第1話】</a></div><h2 class="name"><a href="${url}">Work &amp; Name</a></h2></div>`;
  return `<div><h4>Search: ${query.replaceAll('&', '&amp;')}</h4><div class="grid-of-mangas">${card}</div>
    <div class="z-pagination">${next || page > 1 ? `<span aria-current="page" class="page-numbers current">${page}</span>` : ''}${next ? `<a class="next page-numbers" href="${origin}/page/${page + 1}/?${new URLSearchParams({s: query})}">最後 »</a>` : ''}</div></div>`;
}
