import {describe, expect, it} from 'vitest';
import {definition, catalogKey} from '../definition';
import {describeWork} from '../page';
import {detail, propsJson, reader, readerUrl, url, work} from './fixtures';

function fixture(target = url, data: Record<string, unknown> = target === url ? detail() : reader()) {
  const nodes: Record<string, {getAttribute(name: string): string | null}[]> = {
    'link[rel="canonical"]': target === url ? [{getAttribute: () => target}] : [],
    'astro-island[component-url]': [{getAttribute: name => name === 'component-url' ?
      '/_astro/' + (target === url ? 'DescriptionModal' : 'ChapterReader') + '.fixture.js' : propsJson(data)}],
  };
  const controller = new AbortController();
  const context = {document: {querySelectorAll: (selector: string) => {
    if (!(selector in nodes)) throw Error('Unexpected document scan: ' + selector);
    return nodes[selector];
  }} as unknown as Document, location: definition.identify(new URL(target))!, signal: controller.signal};
  return {nodes, context, controller, read: () => describeWork(context)};
}
describe('Asura Scans work metadata', () => {
  it.each([url, readerUrl])('gets the work title from bounded SSR metadata at %s', target => {
    expect(fixture(target).read()).toEqual({status: 'ready', value: {title: 'Fixture & Book', catalogId: catalogKey(work), catalogUrl: url}});
  });
  it('does not decode the page list to identify a work', () => {
    const f = fixture(readerUrl, {...reader(), pages: undefined});
    expect(f.read().status).toBe('ready');
  });
  it('rejects stale navigation, missing/ambiguous metadata and cancellation', () => {
    const f = fixture(readerUrl); f.context.location = definition.identify(new URL(url + '/chapter/2'))!;
    expect(f.read().status).toBe('not-ready');
    for (const selector of Object.keys(f.nodes)) {
      const missing = fixture(); missing.nodes[selector] = []; expect(missing.read().status).toBe('not-ready');
      const duplicate = fixture(); duplicate.nodes[selector].push(duplicate.nodes[selector][0]); expect(duplicate.read().status).toBe('not-ready');
    }
    const cancelled = fixture(); cancelled.controller.abort(Error('navigation'));
    expect(cancelled.read).toThrow('navigation');
  });
  it('rejects a different work in reader props', () => {
    expect(fixture(readerUrl, {...reader(), seriesSlug: 'other-1234abcd'}).read().status).toBe('not-ready');
  });
});
