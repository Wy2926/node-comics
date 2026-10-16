import {describe, expect, it, vi} from 'vitest';
import {describeWork} from '../page';
import {catalogKey, chapterUrl, definition} from '../definition';
import {chapter, encoded, reader, url, work} from './fixtures';

function element(textContent: string, attrs: Record<string, string> = {}) {
  return {textContent, getAttribute: (key: string) => attrs[key] ?? null, querySelector: () => null} as unknown as Element;
}
function fixture(target = url) {
  const title = element('', {'data-enc': encoded('サンプル & Book')});
  const owner = element('Sample Work', {href: '/m/' + work});
  const current = element('Chapter 1', {href: '/c/' + chapter});
  const breadcrumb = {querySelectorAll: () => [element('Home', {href: '/'}), owner, current]};
  const nodes: Record<string, unknown[]> = {'.manga-info h3': [title], 'ol.breadcrumb': [breadcrumb]};
  const querySelectorAll = vi.fn((selector: string) => {
    if (!(selector in nodes)) throw Error('Unexpected scan: ' + selector);
    return nodes[selector];
  });
  const controller = new AbortController();
  const context = {document: {title: 'Misleading chapter title', querySelectorAll,
    querySelector: (selector: string) => selector === '#login + script' ? element(`window.location.href='${url}';`) : null} as unknown as Document,
    location: definition.identify(new URL(target))!, signal: controller.signal};
  return {context, nodes, title, current, controller, querySelectorAll, read: () => describeWork(context)};
}

describe('WeLoMa lightweight work metadata', () => {
  it('reads the encoded work heading without scanning chapters or images', () => {
    const f = fixture();
    expect(f.read()).toEqual({status: 'ready', value: {title: 'サンプル & Book', catalogId: catalogKey(work), catalogUrl: url}});
    expect(f.querySelectorAll).toHaveBeenCalledExactlyOnceWith('.manga-info h3');
    f.nodes['.manga-info h3'] = [element('  Decoded   Work  ')];
    expect(f.read()).toMatchObject({value: {title: 'Decoded Work'}});
  });
  it.each([reader, chapterUrl(chapter, work)])('uses the proven work breadcrumb for %s, not the chapter heading', target => {
    expect(fixture(target).read()).toEqual({status: 'ready', value: {title: 'Sample Work', catalogId: catalogKey(work), catalogUrl: url}});
  });
  it.each(['missing', 'duplicate', 'invalid-encoding', 'empty', 'long'])('keeps an unreliable %s work name empty', kind => {
    const f = fixture();
    f.nodes['.manga-info h3'] = kind === 'missing' ? [] : kind === 'duplicate' ? [f.title, f.title] :
      [element(kind === 'long' ? 'x'.repeat(2001) : '', kind === 'invalid-encoding' ? {'data-enc': 'invalid!'} : {})];
    expect(f.read().status).toBe('not-ready');
  });
  it.each(['foreign', 'current', 'binding', 'duplicate', 'empty'])('rejects %s breadcrumb ownership', kind => {
    const f = fixture(kind === 'binding' ? chapterUrl(chapter, 'Other') : reader);
    const owner = element(kind === 'empty' ? '' : 'Work', {href: kind === 'foreign' ? 'https://weloma.net.evil.test/m/' + work : url});
    f.nodes['ol.breadcrumb'] = [{querySelectorAll: () => [owner, kind === 'current' ? element('Other chapter', {href: '/c/Other'}) : f.current,
      ...(kind === 'duplicate' ? [owner] : [])]}];
    expect(f.read().status).toBe('not-ready');
  });
  it('stops after cancellation and does not identify a non-work page', () => {
    const f = fixture(); f.controller.abort(Error('navigation'));
    expect(f.read).toThrow('navigation');
    expect(fixture('https://weloma.net/l/0OYCn').read().status).toBe('not-ready');
  });
  it('rejects a work route change with stale metadata or missing identity without executing the login script', () => {
    expect(fixture('https://weloma.net/m/Other').read().status).toBe('not-ready');
    for (const identity of [null, element('unrelated()'), element('x'.repeat(16_385))]) {
      const f = fixture(); f.context.document.querySelector = () => identity;
      expect(f.read().status).toBe('not-ready');
    }
  });
});
