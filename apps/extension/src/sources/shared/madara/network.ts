import type {SourceNetwork, SourceNetworkContext} from '../../contracts/network';
import type {MadaraSite} from './config';
import {createMadaraParsers} from './index';

/** Bounded protocol orchestration through the caller's transport, never a direct fetch. */
export function createMadaraNetwork(site: MadaraSite) {
  const parsers = createMadaraParsers(site);
  function location(url: string) {
    const loc = site.location(new URL(url));
    if (!loc) throw Error(`${site.name} 来源地址无效。`);
    return loc;
  }
  async function request(url: string, context: SourceNetworkContext, options?: Parameters<SourceNetworkContext['request']>[1]) {
    context.signal?.throwIfAborted();
    const html = options ? await context.request(url, options) : await context.request(url);
    context.signal?.throwIfAborted();
    return html;
  }
  const network = {
    ...(site.searchPageSize === undefined ? {} : {
      async search(input, context) {
        const target = parsers.searchRequest(input);
        return parsers.parseSearch(await request(target.url, context, target.options), input);
      },
    } satisfies Pick<SourceNetwork, 'search'>),
    async catalog(url, context) {
      const loc = location(url);
      if (loc.chapter) throw Error(`请使用 ${site.name} 作品详情页读取目录。`);
      const target = site.catalogUrl(loc.slug);
      const page = parsers.prepareCatalog(await request(target, context), target);
      // Validate the detail page before the one additional, read-only POST. No per-chapter requests.
      return page.parse(page.chapterListUrl ? await request(page.chapterListUrl, context, {referer: target, form: {}}) : undefined);
    },
    async pages(url, context) {
      const loc = location(url);
      if (!loc.chapter) throw Error(`${site.name} 章节地址无效。`);
      return parsers.parsePages(await request(site.chapterUrl(loc) + '?style=list', context), url);
    },
  } satisfies SourceNetwork;
  return {...parsers, network};
}
