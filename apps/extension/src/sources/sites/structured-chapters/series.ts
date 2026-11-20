import type {SourceNetworkContext} from '../../contracts/network';
import type {SourceLocation} from '../../contracts/definition';
import {catalogData, count, directory, incomplete, markup} from './catalog';
import {definition} from './definition';

// Client-side navigation retains the previous page's bootstrap scripts. Read the selected work's own HTML.
function seriesProps(doc: ParentNode, slug: string) {
  type Props = {series_id:number; series_type:string; series:{id:number; series_slug:string; title:string; meta?:{chapters_count?:string|number}}};
  const find = (value: unknown): Props | undefined => {
    if (!value || typeof value !== 'object') return;
    const p = value as Props;
    if (p.series?.series_slug === slug && p.series.id === p.series_id && p.series_type && p.series.meta?.chapters_count != null) return p;
    for (const child of Object.values(value)) {const found = find(child); if (found) return found;}
  };
  const chunks: string[] = [];
  let props: Props | undefined;
  for (const script of doc.querySelectorAll<HTMLScriptElement>('script:not([src])')) {
    const text = script.textContent?.trim() ?? '';
    try {
      if (script.type === 'application/json') props ??= find(JSON.parse(text));
      else if (text.startsWith('self.__next_f.push(')) {
        const chunk = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')));
        if (chunk[0] === 1 && typeof chunk[1] === 'string') chunks.push(chunk[1]);
      }
    } catch { /* Unrelated framework record. */ }
  }
  for (const line of chunks.join('').split('\n')) {
    if (props || !line.includes('"chapters_count"') || !line.includes('"series_id"')) continue;
    try {props = find(JSON.parse(line.slice(line.indexOf(':') + 1)));} catch { /* Not a chapter component. */ }
  }
  if (!props || props.series_type !== 'Comic' || !Number.isSafeInteger(props.series_id) || props.series_id < 1) incomplete();
  return props;
}

export async function seriesList(work: SourceLocation, ctx: SourceNetworkContext) {
  if (!ctx.readDocument) incomplete();
  const base = new URL(work.url), slug = base.pathname.split('/')[2];
  const doc = markup(await ctx.request(work.url,{redirect:'error'}));
  if (!doc.querySelector(definition.linkMatch(work))) incomplete();
  const props = seriesProps(doc, slug), seriesId = props.series_id, total = count(props.series.meta!.chapters_count);
  const result = directory(work, props.series.title, total);
  // This projection runs in the live page. Only the resource used by the verified work may supply its endpoint.
  const observed = catalogData(await ctx.readDocument(async ({pageUrl,documentToken,params}) => {
    if (location.href !== pageUrl || Reflect.get(document,Symbol.for('nc-source-page-document')) !== documentToken) return null;
    const panel = document.querySelector('[role="tabpanel"][id$="-content-chapters_list"]');
    if (!panel?.querySelector('a[href], li button')) return null;
    const links = [...panel.querySelectorAll<HTMLAnchorElement>('a[href]')].map(a => ({href:a.href,title:(a.querySelector('.line-clamp-1') ?? a).textContent?.trim()}));
    const endpoint = performance.getEntriesByType('resource').map(entry => new URL(entry.name,pageUrl))
      .find(url => url.pathname === '/chapter/query' && url.searchParams.get('series_id') === String(params?.seriesId));
    if (!endpoint && links.length !== params?.total) return null;
    return JSON.stringify({links,endpoint:endpoint && endpoint.origin + endpoint.pathname});
  },{seriesId,total}));
  if (!Array.isArray(observed?.links) || observed.links.length > total) incomplete();
  const links = observed.links as {href:string;title:string}[];
  if (!observed.endpoint) {
    for (const link of links) result.add(link.href, link.title);
    return result.finish();
  }
  if (typeof observed.endpoint !== 'string' || !URL.canParse(observed.endpoint)) incomplete();
  const endpoint = new URL(observed.endpoint);
  if (endpoint.protocol !== base.protocol || endpoint.host !== base.host && endpoint.host !== 'api.' + base.host.replace(/^www\./, '') ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/chapter/query' || endpoint.search || endpoint.hash) incomplete();
  const unlocked = new Set(links.map(link => new URL(link.href, work.url).href));
  let size: number | undefined;
  for (let page = 1; page <= total; page++) {
    ctx.signal?.throwIfAborted();
    endpoint.search = new URLSearchParams({page:String(page), perPage:'30', series_id:String(seriesId)}).toString();
    const {meta, data:rows} = catalogData(await ctx.request(endpoint.href, {referer:work.url,redirect:'error'}));
    size ??= count(meta?.per_page);
    const last = Math.ceil(total / size);
    if (count(meta?.total) !== total || count(meta.current_page) !== page || count(meta.per_page) !== size || count(meta.last_page) !== last ||
        !Array.isArray(rows) || rows.length !== Math.min(size, total - (page - 1) * size)) incomplete();
    for (const row of rows) {
      if (row?.series?.id !== seriesId || row.series.series_slug !== slug ||
          typeof row.chapter_slug !== 'string' || !/^[\w-]+$/.test(row.chapter_slug) || !Number.isFinite(row.price) || row.price < 0 ||
          typeof row.chapter_name !== 'string' || !row.chapter_name.trim()) incomplete();
      const url = work.url + '/' + row.chapter_slug;
      result.add(url, [row.chapter_name, row.chapter_title].filter(Boolean).join(' · '), row.price === 0 || unlocked.has(url));
    }
    if (last === page) return result.finish();
  }
  return incomplete();
}
