import {definition} from '../definition';
import {parseCatalog, parsePages} from '../network';
import {parseSearch} from '../search';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {validateSearchPage} from '../../../core/search';

if (location.hostname !== '127.0.0.1' || location.port !== '5181') throw Error('Use the isolated 127.0.0.1:5181 origin.');
const input = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
document.getElementById('parse')!.onclick = () => {
  const started = performance.now();
  let result: unknown;
  try {
    const body = input('body'), url = input('url');
    if (input('mode') === 'catalog') {
      const value = validateCatalog(parseCatalog(body, url), [definition]);
      result = {complete: value.complete, entries: value.entries.length, first: value.entries[0]?.title, last: value.entries.at(-1)?.title, cover: !!value.cover};
    } else if (input('mode') === 'pages') {
      const value = validatePages(parsePages(body, url), definition.identify(new URL(url))!);
      result = {complete: value.discoveryComplete, pages: value.items.length, title: value.title, firstImage: value.items[0].resource.kind};
    } else {
      const value = validateSearchPage(parseSearch(body, {siteId: 'hachiraw', query: input('query'), ...(input('cursor') ? {cursor: input('cursor')} : {})}), definition, definition.sites![0], [definition]);
      result = {items: value.items.length, nextCursor: value.nextCursor};
    }
    result = {ok: true, result, elapsedMs: performance.now() - started};
  } catch (error) {result = {ok: false, error: (error as Error).message};}
  document.getElementById('result')!.textContent = JSON.stringify(result, null, 2);
};
