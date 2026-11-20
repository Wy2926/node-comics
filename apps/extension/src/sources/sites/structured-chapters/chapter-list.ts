import type {SourceNetworkContext} from '../../contracts/network';
import type {SourceLocation} from '../../contracts/definition';
import {catalogData, count, directory, incomplete, markup} from './catalog';
import {definition} from './definition';

export async function chapterList(work: SourceLocation, ctx: SourceNetworkContext) {
  const doc = markup(await ctx.request(work.url,{redirect:'error'})), scope = doc.querySelector<HTMLElement>(definition.linkMatch(work));
  if (!scope) incomplete();
  const endpoint = new URL(scope.dataset.chaptersUrl!, work.url);
  if (endpoint.href !== work.url + '/chapters') incomplete();
  const total = count(scope.dataset.chapterTotal ?? scope.querySelector('h2 + span')?.textContent?.match(/[\d,]+/)?.[0].replaceAll(',', ''));
  const size = count(scope.dataset.chapterPageSize), last = Math.ceil(total / size);
  const result = directory(work, doc.querySelector('h1')?.textContent ?? '', total);
  const add = (root: ParentNode, page: number) => {
    const anchors = root.querySelectorAll<HTMLAnchorElement>('a[data-chapter-id][href]');
    if (anchors.length !== Math.min(size, total - (page - 1) * size)) incomplete();
    for (const a of anchors) {
      const href = new URL(a.getAttribute('href')!, work.url);
      if (!/^\d+$/.test(a.dataset.chapterId ?? '') || href.pathname !== endpoint.pathname + '/' + a.dataset.chapterId) incomplete();
      result.add(href.href, (a.querySelector('[data-chapter-title], .truncate') ?? a).textContent ?? '');
    }
  };
  add(scope, 1);
  if (scope.dataset.chapterNextPage !== (last > 1 ? '2' : '')) incomplete();
  for (let page = 2; page <= last; page++) {
    ctx.signal?.throwIfAborted();
    endpoint.search = new URLSearchParams({sort:'latest', page:String(page), mode:scope.dataset.chapterMode || 'desktop'}).toString();
    const batch = catalogData(await ctx.request(endpoint.href, {referer:work.url, redirect:'error'}));
    if (batch.current_page !== page || batch.last_page !== last || batch.total !== total ||
        batch.has_more !== (page < last) || batch.next_page !== (page < last ? page + 1 : null) || typeof batch.html !== 'string') incomplete();
    add(markup(batch.html), page);
  }
  return result.finish();
}
