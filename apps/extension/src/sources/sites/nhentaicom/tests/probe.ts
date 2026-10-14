import {definition} from '../definition';
import {parseCatalog, parsePages} from '../network';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';

if (location.hostname !== '127.0.0.1' || location.port !== '5181') throw Error('Use the isolated 127.0.0.1:5181 origin.');
const input = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
document.getElementById('parse')!.onclick = () => {
  const started = performance.now();
  let result: unknown;
  try {
    const body = input('body'), url = input('url');
    if (input('mode') === 'catalog') {
      const value = validateCatalog(parseCatalog(body, url), [definition]);
      result = {complete: value.complete, entries: value.entries.length, cover: !!value.cover,
        contentLanguage: value.entries[0]?.contentLanguage};
    } else {
      const value = validatePages(parsePages(body, url), definition.identify(new URL(url))!);
      result = {complete: value.discoveryComplete, pages: value.items.length,
        firstOrder: value.items[0].order, lastOrder: value.items.at(-1)!.order,
        uniqueImageIds: new Set(value.items.map(item => item.id)).size};
    }
    result = {ok: true, result, elapsedMs: performance.now() - started};
  } catch (error) {result = {ok: false, error: (error as Error).message};}
  document.getElementById('result')!.textContent = JSON.stringify(result, null, 2);
};
