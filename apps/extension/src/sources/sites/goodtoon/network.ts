import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceSnapshot} from '../../contracts/source';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {createMadaraParsers} from '../../shared/madara';
import {catalogUrl, chapterUrl} from './definition';
import {artwork, byClass, canonical, location, one, regions, site, text} from './html';
import {parseSearch, searchRequest} from './search';

const {parseChapterList} = createMadaraParsers(site);
function postId(safe: string, slug: string) {
  const body = one(tags(safe, 'body'), '作品标识');
  const id = one((body.class ?? '').split(/\s+/).filter(name => name.startsWith('postid-')), '作品标识').slice(7);
  if (slug !== `gt-${id}`) throw Error('GoodToon 作品标识归属错误。');
  return id;
}
export function prepareCatalog(html: string, url: string) {
  const loc = location(url), safe = inertHtml(html);
  if (loc.chapter) throw Error('请使用 GoodToon 作品详情页链接。');
  canonical(safe, loc);
  const mangaId = postId(safe, loc.slug);
  const holder = one(tags(safe, 'div').filter(a => a.id === 'manga-chapters-holder'), '目录标识');
  if (holder['data-id'] !== mangaId) throw Error('GoodToon 目录作品归属错误。');
  const title = text(textContent(byClass(safe, 'h1', 'summary-title')));
  const box = byClass(safe, 'div', 'manga-summary-cover');
  const owner = location(one(tags(box, 'a'), '封面作品').href);
  if (owner.chapter || owner.slug !== loc.slug) throw Error('GoodToon 封面作品归属错误。');
  const image = one(tags(box, 'img'), '作品封面'), cover = artwork(image['data-src'] || image.src, loc.slug);
  return {url: catalogUrl(loc.slug) + 'ajax/chapters/', parse(chapters: string) {
    // UP is a transient update badge, not part of the chapter name or identity.
    const safeChapters = inertHtml(chapters).replace(/<span\b[^>]*>[\s\S]*?<\/span\s*>/gi, span =>
      hasClass(attributes(span.slice(0, span.indexOf('>') + 1)), 'up-badge-inline') && textContent(span) === 'UP' ? '' : span);
    return parseChapterList(safeChapters, loc.slug, title, cover, mangaId);
  }};
}
export function parsePages(html: string, url: string): SourceSnapshot {
  const loc = location(url), safe = inertHtml(html);
  if (!loc.chapter) throw Error('GoodToon 章节地址无效。');
  canonical(safe, loc); postId(safe, loc.slug);
  const title = text(textContent(one(regions(safe, 'h1', a => a.id === 'chapter-heading'), '章节标题').body));
  const menu = byClass(safe, 'select', 'chapter-select-nav');
  const options = regions(menu, 'option', () => true);
  for (const option of options) {
    const target = location(option.attrs.value);
    if (target.slug !== loc.slug || !target.chapter) throw Error('GoodToon 章节导航归属错误。');
  }
  const selected = one(options.filter(option => {
    // Native markup uses the boolean selected attribute; do not match the word inside quoted values.
    const tag = menu.slice(option.start, menu.indexOf('>', option.start) + 1).replace(/"[^"]*"|'[^']*'/g, '""');
    return /\sselected(?=[\s=>])/i.test(tag);
  }), '当前章节');
  if (location(selected.attrs.value).chapter !== loc.chapter || textContent(selected.body) !== title)
    throw Error('GoodToon 章节标题与导航不一致。');
  let viewer = byClass(safe, 'div', 'reading-content');
  const ads = regions(viewer, 'div', a => !!hasClass(a, 'gt-reader-ad'));
  if (ads.length) {
    const ad = one(ads, '正文尾部广告'), image = one(tags(ad.body, 'img'), '广告图片');
    const asset = new URL(site.imageUrl(image.src));
    if (viewer.slice(ad.end).trim() || image.id || image.alt !== 'ad' || hasClass(image, 'wp-manga-chapter-img') ||
        asset.origin !== site.origin || !/^\/wp-content\/uploads\/ads\/reader_bottom_\d+\.(?:gif|jpe?g|png|webp)$/.test(asset.pathname) ||
        /<(?:iframe|canvas|video|select|input)\b/i.test(ad.body)) throw Error('GoodToon 正文尾部广告结构变化。');
    // Only this verified final ad is excluded; unknown images still invalidate the page manifest.
    viewer = viewer.slice(0, ad.start);
  }
  const current = one(tags(viewer, 'input').filter(a => a.id === 'wp-manga-current-chap'), '正文标识');
  const images = tags(viewer, 'img');
  if (current.value !== loc.chapter || !/^[1-9]\d*$/.test(current['data-id'] ?? '') || !images.length || images.length > 1500 ||
      /<(?:iframe|canvas|video|select)\b/i.test(viewer)) throw Error('GoodToon 未提供完整图片正文。');
  const imagePath = new RegExp(`^/(?:r2img/)?${loc.slug}/[^/]+/[^/]+\\.(?:jpe?g|png|webp|avif)$`, 'i');
  const items = images.map((image, order) => {
    if (image.id !== `image-${order}` || !hasClass(image, 'wp-manga-chapter-img')) throw Error('GoodToon 正文缺页或页序错误。');
    const resource = site.imageUrl(image['data-src'] || image.src);
    if (!imagePath.test(new URL(resource).pathname))
      throw Error('GoodToon 正文图片作品归属错误。');
    return {id: image.id, order, width: 0, height: 0, resource: {kind: 'http' as const, url: resource}};
  });
  return {url, adapter: site.id, title, direction: 'ltr', discoveryComplete: true, knownTotal: items.length, note: '', items};
}
async function request(context: SourceNetworkContext, url: string, options?: Parameters<SourceNetworkContext['request']>[1]) {
  context.signal?.throwIfAborted();
  const body = await context.request(url, options);
  context.signal?.throwIfAborted();
  return body;
}
export const network = {
  async catalog(url, context) {
    const loc = location(url);
    if (loc.chapter) throw Error('请使用 GoodToon 作品详情页链接。');
    const target = catalogUrl(loc.slug), prepared = prepareCatalog(await request(context, target), target);
    return prepared.parse(await request(context, prepared.url, {referer: target, form: {}}));
  },
  async pages(url, context) {
    const loc = location(url);
    if (!loc.chapter) throw Error('GoodToon 章节地址无效。');
    return parsePages(await request(context, chapterUrl(loc)), url);
  },
  async search(input, context) {
    const target = searchRequest(input);
    return parseSearch(await request(context, target.url), input);
  },
} satisfies SourceNetwork;
