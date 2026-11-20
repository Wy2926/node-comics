import type {SourceDefinition, SourceLocation} from '../../contracts/definition';

const id = 'structured-chapters';
const shapes = [
  ['series', /^(\/series\/[\w-]+)(\/[\w-]+)?$/, '[role="tabpanel"][id$="-content-chapters_list"]', 'img[data-fallback-index]'],
  ['list', /^(\/comics\/\d+)(\/chapters\/\d+)?$/, '#chapters[data-chapter-sort-scope][data-chapters-url]',
    (path:string) => `[data-reader-shell][data-reader-chapter-id="${path.split('/').pop()}"] [data-reader-canvas] [data-reader-page] img[data-reader-image]`],
  ['menu', /^(\/manga\/[\w-]+)(\/chapter-\d+(?:[.-]\d+)*)?$/, '#chapterlist > .row-content-chapter > li > a.chapter-name[href]', '.read-manga .read-content > .page-break > img'],
  ['numbered', /^(\/comic\/[\w-]+)(\/chapter-\d+)?\.html$/, '#list > ul[id^="mh-chapter-list-ol-"] > li > a[href]', '#currentCache .view-imgBox .img-wrap > img'],
  ['counted', /^(\/read-[a-z]+\/[\w-]+?)(-chapter-\d+(?:[.-]\w+)*-ch\d+)?$/, '#chapters #chapter-list > a[data-name][href]', '[data-reader][data-comic-url] > [data-pages] > img'],
] as const;

export function matchLink(url: URL) {
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  const path = url.pathname.replace(/\/$/, '');
  if (path.length>2048) return null;
  for (const [layout, pattern, catalog, reader] of shapes) {
    const route = pattern.exec(path);
    if (!route) continue;
    const page = url.origin + path, work = url.origin + route[1] + (layout === 'numbered' ? '.html' : '');
    const location:SourceLocation = {sourceId:id, kind:route[2] ? 'reader' : 'catalog', url:page, pageKey:id + ':' + page, catalog:{url:work, key:id + ':' + work}};
    return {layout, location, selector:route[2] ? typeof reader === 'string' ? reader : reader(path) : catalog};
  }
  return null;
}
export const identify = (url:URL) => matchLink(url)?.location ?? null;
export const definition = {
  id, name:'网页漫画', identify,
  linkMatch(location) {return matchLink(new URL(location.url))!.selector;},
  capabilities:{pages:true, catalog:true, completePageList:true, importable:true, inline:true, findAlternatives:false},
  inlineRecognition:'generic', installation:{autoContentMatches:[]},
} satisfies SourceDefinition;
