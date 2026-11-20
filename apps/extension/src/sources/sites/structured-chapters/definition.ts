import type {SourceDefinition, SourceLocation} from '../../contracts/definition';

const id = 'structured-chapters';
export function identify(url: URL): SourceLocation | null {
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  const path = url.pathname.replace(/\/$/, '');
  const route = /^(\/series\/[\w-]+)(\/[\w-]+)?$/.exec(path) ?? /^(\/comics\/\d+)(\/chapters\/\d+)?$/.exec(path);
  if (!route) return null;
  const page = url.origin + path, work = url.origin + route[1];
  return {sourceId:id, kind:route[2] ? 'reader' : 'catalog', url:page, pageKey:id + ':' + page, catalog:{url:work, key:id + ':' + work}};
}
export const definition = {
  id, name:'网页漫画', identify,
  linkMatch(location) {
    const series = new URL(location.url).pathname.startsWith('/series/');
    return location.kind === 'catalog'
      ? series ? '[role="tabpanel"][id$="-content-chapters_list"]' : '#chapters[data-chapter-sort-scope][data-chapters-url]'
      : series ? 'img[data-fallback-index]' : `[data-reader-shell][data-reader-chapter-id="${new URL(location.url).pathname.split('/').pop()}"] [data-reader-canvas] [data-reader-page] img[data-reader-image]`;
  },
  capabilities:{pages:true, catalog:true, completePageList:true, importable:true, inline:true, findAlternatives:false},
  inlineRecognition:'generic', installation:{autoContentMatches:[]},
} satisfies SourceDefinition;
