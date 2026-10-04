import {catalogUrl, chapterUrl} from '../definition';

export const slug = '契約-fixture-raw-free';
export const chapterSlug = '契約-fixture-raw-【第1話】';
export const url = catalogUrl(slug);
export const reader = chapterUrl(chapterSlug, slug);
export const image = 'https://p1.pubg-img.si:183/d/abcdef/page%201.jpg';
export const cover = 'https://rawlazy.io/wp-content/uploads/2025/08/fixture.jpg';
export const chaptersHtml = () => `<div class="chapters-list">
  <a href="${chapterUrl('契約-fixture-raw-【第7-5話】')}"><span class="font-bold">第7.5話</span></a>
  <a href="${chapterUrl(chapterSlug)}"><span class="font-bold">第1話</span></a>
</div>`;
export const catalogHtml = () => `<!doctype html><link rel="canonical" href="${url}">
  <h1 class="font-bold mb-2">Work &amp; Name</h1><img class="thumb" alt="Cover Image" src="${cover}">
  <div class="chapter-list-lb">章リスト</div>${chaptersHtml()}`;
export const readerHtml = () => `<!doctype html><meta property="og:url" content="${chapterUrl(chapterSlug)}">
  <h1 class="post-title entry-title">Chapter &amp; One</h1>
  <div class="manga-name"><h2><a href="${url}">Work &amp; Name</a></h2></div>${chaptersHtml()}
  <script id="custom.js-js-extra">var zing = {"home_url":"https://rawlazy.io","ajax_url":"https://rawlazy.io/wp-admin/admin-ajax.php","nonce":"abc1234567"};</script>
  <script>function do_work(){ $.ajax({ data: { _action: 'decode_images', p: 3355950, img_index: img_index } }); }</script>`;
export const batch = (urls: string[], index = urls.length, going = 0, delay = 0) => JSON.stringify({
  mes: urls.map(src => `<img src="${src}" data-preload="yes">`).join(''), img_index: index, going, next_timeout: delay,
});
