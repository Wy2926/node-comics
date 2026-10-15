import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {MangaThemesiaSite} from './config';
import {createMangaThemesiaParsers} from './index';

export function createMangaThemesiaNetwork(site: MangaThemesiaSite) {
  const parsers = createMangaThemesiaParsers(site);
  function location(url: string) {
    const loc = site.location(new URL(url));
    if (!loc) throw Error(`${site.name} 来源地址无效。`);
    return loc;
  }
  async function request(url: string, context: SourceNetworkContext) {
    context.signal?.throwIfAborted();
    const html = await context.request(url);
    context.signal?.throwIfAborted();
    return html;
  }
  const network = {
    async search(input, context) {
      return parsers.parseSearch(await request(parsers.searchUrl(input), context), input);
    },
    async resolveCatalog(url, context) {
      const loc = location(url);
      if (!loc.chapterSlug) throw Error(`${site.name} 章节地址无效。`);
      return parsers.readerInfo(await request(site.chapterUrl(loc.chapterSlug), context), url).catalogUrl;
    },
    async catalog(url, context) {
      const loc = location(url);
      if (!loc.catalogSlug || loc.chapterSlug) throw Error(`请使用 ${site.name} 作品详情页读取目录。`);
      return parsers.parseCatalog(await request(site.catalogUrl(loc.catalogSlug), context), url);
    },
    async pages(url, context) {
      const loc = location(url);
      if (!loc.chapterSlug) throw Error(`${site.name} 章节地址无效。`);
      return parsers.parsePages(await request(site.chapterUrl(loc.chapterSlug), context), url);
    },
  } satisfies SourceNetwork;
  return {...parsers, network};
}
