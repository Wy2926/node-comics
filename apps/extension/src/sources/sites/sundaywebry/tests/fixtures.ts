import {catalogUrl, episodeUrl} from '../definition';
export const imageUrl = 'https://cdn-img.www.sunday-webry.com/public/page/2/900-abcdef';
export const cover = 'https://cdn-img.www.sunday-webry.com/public/series-thumbnail/7-abcdef';
export const workUrl = catalogUrl('7', '11');
export const readerData = (episode = '11', series = '7') => ({readableProduct: {
  id: episode, typeName: 'episode', title: '第1話', permalink: episodeUrl(episode),
  series: {id: series, title: 'テスト作品', thumbnailUri: cover}, isPublic: true,
  pageStructure: {choJuGiga: 'baku', readingDirection: 'rtl', startPosition: 'latter',
    pages: [{type: 'main', width: 67, height: 99, src: imageUrl}, {type: 'other'},
      {type: 'main', width: 67, height: 99, src: imageUrl}, {type: 'backMatter'}]},
}});
export const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('<', '&lt;');
export const readerHtml = (data = readerData()) => `<link rel="canonical" href="${data.readableProduct.permalink}">
  <script id="episode-json" type="text/json" data-value="${escape(JSON.stringify(data))}"></script>`;
export const entry = (episode: string, canRead = true) => ({readable_product_id: episode, title: '第' + episode + '話',
  viewer_uri: episodeUrl(episode), purchase_info: {can_read: canRead}, status: null});
export const info = {type: 'number', readable_products_count: 3, per_page: 2};
export const searchHtml = (query = 'テスト', ids = ['7']) => `<html data-route="common:search_result"><input name="q" value="${escape(query)}">
  <ul class="${ids.length ? 'series-list' : 'list-empty'}">${ids.map(id => `<li data-title="作品 ${id}">
    <img src="https://cdn-img.www.sunday-webry.com/public/series-thumbnail/${id}-abcdef">
    <p class="author">作者</p><a class="main-link" href="${episodeUrl('11')}">1話を読む</a></li>`).join('')}</ul></html>`;
