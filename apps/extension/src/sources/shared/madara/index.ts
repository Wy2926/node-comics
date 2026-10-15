import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {attributes, hasClass, inertHtml, tags, textContent} from '../html';
import type {MadaraSite} from './config';
import {madaraHtml} from './html';
import {madaraSearch} from './search';

/** Pure front-end parsers. Sites retain registration, transport, cancellation and inline policy. */
export function createMadaraParsers(site: MadaraSite) {
  if (site.search === 'ajax' && site.searchPageSize === undefined) throw Error('Madara AJAX 搜索缺少分页配置。');
  if (site.searchPageSize !== undefined && (!Number.isInteger(site.searchPageSize) || site.searchPageSize < 1 || site.searchPageSize > 100))
    throw Error('Madara 搜索分页配置无效。');
  const helpers = madaraHtml(site);
  const {byClass, canonical, cover, location, one, regions, text} = helpers;
  function postId(html: string) {
    const body = one(tags(html, 'body'), '作品标识');
    const id = one((body.class ?? '').split(/\s+/).filter(name => name.startsWith('postid-')), '作品标识').slice(7);
    if (!/^[1-9]\d*$/.test(id)) throw Error(`${site.name} 作品标识无效。`);
    return id;
  }
  function prepareCatalog(html: string, url: string) {
    const loc = location(url), safe = inertHtml(html);
    if (loc.chapter) throw Error(`请使用 ${site.name} 作品详情页读取目录。`);
    canonical(safe, loc);
    const heading = one(regions(safe, 'h1', () => true), '作品标题').body;
    const title = text(textContent(heading.replace(/<span\b[^>]*>[\s\S]*?<\/span\s*>/gi,
      span => hasClass(attributes(span.slice(0, span.indexOf('>') + 1)), 'manga-title-badges') ? '' : span)));
    const artwork = cover(byClass(safe, 'div', 'summary_image'), loc.slug);
    let mangaId: string | undefined;
    if (site.catalog === 'ajax') {
      mangaId = postId(safe);
      const holder = one(tags(safe, 'div').filter(a => a.id === 'manga-chapters-holder'), '目录标识');
      if (holder['data-id'] !== mangaId) throw Error(`${site.name} 目录归属错误。`);
    }
    return {
      chapterListUrl: site.catalog === 'ajax' ? site.catalogUrl(loc.slug) + 'ajax/chapters/' : undefined,
      parse(chaptersHtml?: string): SourceCatalogSnapshot {
        if ((site.catalog === 'ajax') !== (chaptersHtml !== undefined)) throw Error(`${site.name} 目录响应缺失或不符合协议。`);
        return parseChapters(chaptersHtml === undefined ? safe : inertHtml(chaptersHtml), loc.slug, title, artwork, mangaId);
      },
    };
  }
  function parseChapters(safe: string, slug: string, title: string, artwork: {url: string}, mangaId?: string): SourceCatalogSnapshot {
    const box = byClass(safe, 'div', 'listing-chapters_wrap');
    const list = one(regions(box, 'ul', a => !!hasClass(a, 'main') && !hasClass(a, 'has-volumn') &&
      (!!hasClass(a, 'no-volumn') || !!hasClass(a, 'version-chap'))), '完整目录').body;
    const rows = regions(list, 'li', a => !!hasClass(a, 'wp-manga-chapter')).map(row => regions(row.body, 'a', () => true));
    const linkCount = rows.reduce((count, links) => count + links.length, 0);
    if (!rows.length || rows.length > 10000 || (list.match(/<li\b/gi)?.length ?? 0) !== rows.length ||
        tags(box, 'a').length !== linkCount || tags(box, 'ul').length !== 1)
      throw Error(`${site.name} 目录不完整或分组结构已变化。`);
    if (mangaId) {
      const links = tags(safe, 'a'), reverse = links.filter(a => hasClass(a, 'btn-reverse-order'));
      // The complete AJAX response contains only its list and an optional local reverse-order link.
      // A next-page link/control, even outside the list wrapper, must not become a complete catalog.
      if (reverse.length > 1 || reverse.some(a => a.href !== '#') || links.length !== linkCount + reverse.length ||
          tags(safe, 'ul').length !== 1 || /<(?:nav|button|form|select)\b/i.test(safe))
        throw Error(`${site.name} AJAX 目录含未支持的分页或额外内容。`);
    }
    const id = site.catalogKey(slug), seen = new Map<string, string>();
    // Static list includes Show more rows. Native Previous/Next follows the reverse order.
    const entries = rows.reverse().flatMap(links => {
      // Some AJAX lists expose a download button. It is not a chapter link or a request to download.
      if (mangaId && links.length > 1) {
        const downloads = links.filter(a => hasClass(a.attrs, 'btn-chapter-download'));
        if (downloads.length > 1 || downloads.some(a => a.attrs.href !== '#' || a.attrs['data-manga_id'] !== mangaId || !/^[1-9]\d*$/.test(a.attrs['data-chapter'] ?? '')))
          throw Error(`${site.name} 章节下载标识归属错误。`);
        links = links.filter(a => !hasClass(a.attrs, 'btn-chapter-download'));
      }
      // Recent-release badges repeat the chapter URL but are not chapter titles.
      const link = one(links.filter(a => !hasClass(a.attrs, 'c-new-tag')), '章节链接'), target = location(link.attrs.href);
      const label = text(textContent(link.body));
      if (!target.chapter || target.slug !== slug || seen.has(target.chapter) && seen.get(target.chapter) !== label ||
          links.some(a => a !== link && site.chapterKey(location(a.attrs.href)) !== site.chapterKey(target)))
        throw Error(`${site.name} 章节重复或归属错误。`);
      if (seen.has(target.chapter)) return [];
      const order = seen.size; seen.set(target.chapter, label);
      return [{id: site.chapterKey(target), catalogId: id, remoteId: target.chapter, url: site.chapterUrl(target),
        title: label, order, groupIds: ['chapters'], rawTypes: [], related: false, sequenceId: id}];
    });
    return {id, sourceId: site.id, url: site.catalogUrl(slug), title, cover: artwork, complete: true,
      observedAt: Date.now(), note: '', groups: [{id: 'chapters', title: 'Chapters', entryIds: entries.map(e => e.id), complete: true}],
      entries, defaultEntryId: entries[0].id};
  }
  function parseCatalog(html: string, url: string, chaptersHtml?: string): SourceCatalogSnapshot {
    return prepareCatalog(html, url).parse(chaptersHtml);
  }
  function parsePages(html: string, url: string): SourceSnapshot {
    const loc = location(url), safe = inertHtml(html);
    if (!loc.chapter) throw Error(`${site.name} 章节地址无效。`);
    canonical(safe, site.reader === 'catalog-select' ? {slug: loc.slug} : loc);
    const menus = regions(safe, 'select', a => !!hasClass(a, 'single-chapter-select'));
    const navigation = safe.includes('chapters_selectbox_holder') ? tags(safe, 'div') : [];
    const holders = navigation.filter(a => hasClass(a, 'chapters_selectbox_holder'));
    let selectedTitle: string | undefined;
    if (site.reader === 'ajax-select') {
      const mangaId = postId(safe);
      const nav = one(navigation.filter(a => a.id === 'manga-reading-nav-head'), '章节导航');
      // Some Madara layouts repeat the same chapter picker in the top breadcrumb as well as head/foot.
      if (![2, 3].includes(holders.length) || nav['data-id'] !== mangaId || nav['data-chapter'] !== loc.chapter ||
          holders.some(a => a['data-manga'] !== mangaId || a['data-chapter'] !== loc.chapter || a['data-type'] !== 'manga' || a['data-style'] !== 'list' || a['data-vol'] !== '0'))
        throw Error(`${site.name} 章节导航归属错误。`);
      // A server-populated picker is the same protocol, but every holder must contain exactly one menu.
      // Reject mixed/partial loading and standalone menus; selected values are checked below as usual.
      if (menus.length) {
        const populated = regions(safe, 'div', a => !!hasClass(a, 'chapters_selectbox_holder'));
        if (menus.length !== holders.length || populated.length !== holders.length || populated.some(holder =>
          regions(holder.body, 'select', a => !!hasClass(a, 'single-chapter-select')).length !== 1))
          throw Error(`${site.name} 章节选择框未完整绑定导航。`);
      }
    } else if (!menus.length || holders.length) throw Error(`${site.name} 章节导航缺失或不符合协议。`);
    for (const menu of menus) {
      const option = one(regions(menu.body, 'option', a => a.selected !== undefined), '当前章节');
      const selected = option.attrs, label = text(textContent(option.body));
      if (selected.value !== loc.chapter || site.chapterKey(location(selected['data-redirect'])) !== site.chapterKey(loc) || selectedTitle !== undefined && selectedTitle !== label)
        throw Error(`${site.name} 当前章节归属错误。`);
      selectedTitle = label;
    }
    const title = site.reader === 'catalog-select' ? text(selectedTitle) :
      text(textContent(one(regions(safe, 'h1', a => a.id === 'chapter-heading'), '章节标题').body));
    const viewer = byClass(safe, 'div', 'reading-content');
    const current = one(tags(viewer, 'input').filter(a => a.id === 'wp-manga-current-chap'), '正文标识');
    const rows = regions(viewer, 'div', a => !!hasClass(a, 'page-break'));
    if (current.value !== loc.chapter || !/^[1-9]\d*$/.test(current['data-id'] ?? '') || !rows.length || rows.length > 1500 ||
        tags(viewer, 'img').length !== rows.length || /<(?:iframe|video|canvas|select)\b/i.test(viewer))
      throw Error(`${site.name} 未提供完整图片正文。`);
    const items = rows.map((row, order) => {
      const image = one(tags(row.body, 'img'), '正文图片');
      if (!hasClass(image, 'wp-manga-chapter-img') || image.id !== `image-${order}`) throw Error(`${site.name} 正文缺页或页序错误。`);
      return {id: image.id, order, width: 0, height: 0, resource: {kind: 'http' as const, url: site.imageUrl(image['data-src'] || image.src)}};
    });
    return {url, adapter: site.id, title, direction: site.direction, note: '', discoveryComplete: true, knownTotal: items.length, items};
  }
  return {prepareCatalog, parseCatalog, parsePages, ...madaraSearch(site, helpers)};
}
