import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {SourceSnapshot} from '../../contracts/source';
import {attributes, hasClass, inertHtml, tags, textContent} from '../../shared/html';
import {createMadaraParsers} from '../../shared/madara';
import {isOrigin} from './definition';
import {documentHtml, goodtoonHtml} from './html';
import {parseSearch, searchRequest} from './search';

const {one} = goodtoonHtml();
function postId(safe: string, slug: string) {
  const body = one(tags(safe, 'body'), '作品标识');
  const id = one((body.class ?? '').split(/\s+/).filter(name => name.startsWith('postid-')), '作品标识').slice(7);
  if (slug !== `gt-${id}`) throw Error('GoodToon 作品标识归属错误。');
  return id;
}
export function prepareCatalog(html: string, url: string) {
  const safe = inertHtml(html), {site, location, text, byClass, artwork} = documentHtml(safe, url), loc = location(url);
  if (loc.chapter) throw Error('请使用 GoodToon 作品详情页链接。');
  const mangaId = postId(safe, loc.slug);
  const holder = one(tags(safe, 'div').filter(a => a.id === 'manga-chapters-holder'), '目录标识');
  if (holder['data-id'] !== mangaId) throw Error('GoodToon 目录作品归属错误。');
  const title = text(textContent(byClass(safe, 'h1', 'summary-title')));
  const box = byClass(safe, 'div', 'manga-summary-cover');
  const owner = location(one(tags(box, 'a'), '封面作品').href);
  if (owner.chapter || owner.slug !== loc.slug) throw Error('GoodToon 封面作品归属错误。');
  const image = one(tags(box, 'img'), '作品封面'), cover = artwork(image['data-src'] || image.src, loc.slug);
  const {parseChapterList} = createMadaraParsers(site), referer = site.catalogUrl(loc.slug);
  return {url: referer + 'ajax/chapters/', referer, parse(chapters: string) {
    // UP is a transient update badge, not part of the chapter name or identity.
    const safeChapters = inertHtml(chapters).replace(/<span\b[^>]*>[\s\S]*?<\/span\s*>/gi, span =>
      hasClass(attributes(span.slice(0, span.indexOf('>') + 1)), 'up-badge-inline') && textContent(span) === 'UP' ? '' : span);
    return parseChapterList(safeChapters, loc.slug, title, cover, mangaId);
  }};
}
export function preparePages(response: string, url: string) {
  const helpers = goodtoonHtml(new URL(url).origin), loc = helpers.location(url), mangaId = loc.slug.slice(3);
  if (!loc.chapter) throw Error('GoodToon 章节地址无效。');
  let payload;
  try {payload = JSON.parse(response);} catch {throw Error('GoodToon 章节接口响应无效。');}
  const data = payload?.data?.data;
  if (payload?.success !== true || typeof data?.content !== 'string' || typeof data?.nav !== 'string')
    throw Error('GoodToon 章节接口响应无效。');
  const nav = inertHtml(data.nav);
  const holder = one(tags(nav, 'div').filter(a => hasClass(a, 'chapters_selectbox_holder')), '章节导航');
  if (holder['data-manga'] !== mangaId || holder['data-chapter'] !== loc.chapter || holder['data-type'] !== 'manga' ||
      holder['data-style'] !== 'list') throw Error('GoodToon 章节导航归属错误。');
  const styles = helpers.byClass(nav, 'select', 'reading-style-select');
  const style = one(helpers.regions(styles, 'option', a => a.selected !== undefined), '阅读模式');
  const currentUrl = new URL(helpers.text(style.attrs['data-redirect']), url), currentLoc = helpers.location(currentUrl.href);
  if (currentLoc.slug !== loc.slug || currentLoc.chapter !== loc.chapter || currentUrl.searchParams.get('style') !== 'list')
    throw Error('GoodToon 未提供完整图片正文。');
  const {site, location, text, byClass, regions} = goodtoonHtml(currentUrl.origin);
  let viewer = byClass(inertHtml(data.content), 'div', 'reading-content');
  const ads = regions(viewer, 'div', a => !!hasClass(a, 'gt-reader-ad'));
  const positions = new Set<string>();
  for (const ad of ads.reverse()) {
    const image = one(tags(ad.body, 'img'), '广告图片');
    const asset = new URL(site.imageUrl(image.src));
    const position = /^\/wp-content\/uploads\/ads\/reader_(top|bottom)_\d+\.(?:gif|jpe?g|png|webp)$/.exec(asset.pathname)?.[1];
    if (!position || positions.has(position) || image.id || image.alt !== 'ad' || hasClass(image, 'wp-manga-chapter-img') ||
        !isOrigin(asset) || /<(?:iframe|canvas|video|select|input)\b/i.test(ad.body) ||
        (position === 'top' ? viewer.slice(0, ad.start).replace(/<input\b[^>]*>/gi, '').trim() : viewer.slice(ad.end).trim()))
      throw Error('GoodToon 正文广告结构变化。');
    positions.add(position);
    // Only verified edge ads are excluded; unknown images still invalidate the page manifest.
    viewer = viewer.slice(0, ad.start) + viewer.slice(ad.end);
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
  return {url: site.origin + '/wp-admin/admin-ajax.php', referer: site.chapterUrl(loc),
    form: {action: 'manga_get_reading_nav', manga: mangaId, chapter: loc.chapter, volume_id: '0', style: 'list', type: 'manga'},
    parse(navigation: string): SourceSnapshot {
      const menu = byClass(inertHtml(navigation), 'select', 'single-chapter-select');
      for (const option of tags(menu, 'option')) {
        const target = location(option['data-redirect']);
        if (target.slug !== loc.slug || !target.chapter || target.chapter !== option.value)
          throw Error('GoodToon 章节导航归属错误。');
      }
      const selected = one(regions(menu, 'option', a => a.selected !== undefined), '当前章节');
      if (selected.attrs.value !== loc.chapter) throw Error('GoodToon 章节标题与导航不一致。');
      const title = text(textContent(selected.body));
      return {url, adapter: site.id, title, direction: 'ltr', discoveryComplete: true, knownTotal: items.length, note: '', items};
    }};
}
async function request(context: SourceNetworkContext, url: string, options?: Parameters<SourceNetworkContext['request']>[1]) {
  context.signal?.throwIfAborted();
  const body = await context.request(url, options);
  context.signal?.throwIfAborted();
  return body;
}
export const network = {
  async catalog(url, context) {
    const {site, location} = goodtoonHtml(new URL(url).origin);
    const loc = location(url);
    if (loc.chapter) throw Error('请使用 GoodToon 作品详情页链接。');
    const target = site.catalogUrl(loc.slug), prepared = prepareCatalog(await request(context, target), target);
    return prepared.parse(await request(context, prepared.url, {referer: prepared.referer, form: {}}));
  },
  async pages(url, context) {
    const {site, location} = goodtoonHtml(new URL(url).origin);
    const loc = location(url);
    if (!loc.chapter) throw Error('GoodToon 章节地址无效。');
    // The list-style AJAX response contains every image, without the full page's layout and scripts.
    const query = new URLSearchParams({postID: loc.slug.slice(3), chapter: loc.chapter, 'manga-paged': '1',
      style: 'list', action: 'chapter_navigate_page'});
    const prepared = preparePages(await request(context, site.origin + '/wp-admin/admin-ajax.php?' + query), url);
    return prepared.parse(await request(context, prepared.url, {referer: prepared.referer, form: prepared.form}));
  },
  async search(input, context) {
    const target = searchRequest(input);
    return parseSearch(await request(context, target.url), input);
  },
} satisfies SourceNetwork;
