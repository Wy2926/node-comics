import {describe, expect, it, vi} from 'vitest';
import type {DescribeSourceWork, SourcePageContext} from '../../../contracts/page';
import type {SourceDefinition} from '../../../contracts/definition';
import {definition as eclipse} from '../../../sites/mangaeclipse/definition';
import {describeWork as eclipseWork} from '../../../sites/mangaeclipse/page';
import {definition as bun} from '../../../sites/bunmanga/definition';
import {describeWork as bunWork} from '../../../sites/bunmanga/page';
import {definition as lh} from '../../../sites/lhtranslation/definition';
import {describeWork as lhWork} from '../../../sites/lhtranslation/page';

const sites: Array<{definition: SourceDefinition; describeWork: DescribeSourceWork; catalogCanonical?: boolean}> = [
  {definition: eclipse, describeWork: eclipseWork, catalogCanonical: true},
  {definition: bun, describeWork: bunWork},
  {definition: lh, describeWork: lhWork},
];
const element = (href: string, textContent = '') => ({textContent, getAttribute: (name: string) => name === 'href' ? href : null});
function fixture(site: typeof sites[number], reader = false) {
  const origin = new URL(site.definition.sites![0].url).origin, workUrl = origin + '/manga/fixture-book/';
  const url = reader ? workUrl + 'chapter-1/?style=paged' : workUrl;
  const canonical = reader && !site.catalogCanonical ? workUrl + 'chapter-1/' : workUrl;
  const elements = {
    canonical: [element(canonical)],
    links: [element(origin + '/', 'Home'), element(origin + '/manga-genre/action/', 'Action'), element(workUrl, '\n\tFixture & Book\t ')],
  };
  const document = {
    // Even the catalog path must not guess from generic page or chapter titles.
    get title(): string {throw Error('document.title must not be read');},
    querySelectorAll: vi.fn((selector: string) => {
      if (selector === 'link[rel="canonical"]') return elements.canonical;
      if (selector === '.c-breadcrumb .breadcrumb a[href]') return elements.links;
      throw Error('Unexpected page scan: ' + selector);
    }),
  };
  const controller = new AbortController();
  const context: SourcePageContext = {document: document as unknown as Document, location: site.definition.identify(new URL(url))!, signal: controller.signal};
  return {context, controller, document, elements, workUrl, canonical, read: () => site.describeWork(context)};
}

describe.each(sites)('$definition.name lightweight work metadata', site => {
  it.each([false, true])('reads only the exact work breadcrumb on reader=%s', reader => {
    const f = fixture(site, reader);
    expect(f.read()).toEqual({status: 'ready', value: {title: 'Fixture & Book', catalogId: `${site.definition.id}:manga:fixture-book`, catalogUrl: f.workUrl}});
    expect(f.document.querySelectorAll).toHaveBeenCalledTimes(2);
    expect(site.definition.inlineRecognition).toBe('generic');
  });
  it('accepts identical repeated navigation but rejects conflicting work names', () => {
    const f = fixture(site, true);
    f.elements.links.push(element(f.workUrl, 'Fixture & Book'));
    expect(f.read().status).toBe('ready');
    f.elements.links.push(element(f.workUrl, 'Different work'));
    expect(f.read().status).toBe('not-ready');
  });
  it.each(['https://foreign.test/manga/fixture-book/', '/manga/other-book/', '/manga/fixture-book/chapter-1/', 'javascript:void(0)'])(
    'never substitutes a non-work or wrong-owner breadcrumb %s', href => {
      const f = fixture(site, true);
      f.elements.links = [element(href, 'Chapter 1')];
      expect(f.read().status).toBe('not-ready');
    });
  it('accepts relative work links without trusting a page base element', () => {
    const f = fixture(site, true);
    f.elements.links = [element('/manga/fixture-book/', 'Fixture & Book')];
    expect(f.read().status).toBe('ready');
  });
  it.each(['', ' ', '\u0000invalid', 'x'.repeat(2001)])('leaves unavailable titles empty', title => {
    const f = fixture(site);
    f.elements.links = [element(f.workUrl, title)];
    expect(f.read().status).toBe('not-ready');
  });
  it('rejects missing, repeated, foreign and stale canonical identities', () => {
    const f = fixture(site, true);
    for (const links of [[], [element(f.canonical), element(f.canonical)], [element('https://foreign.test/manga/fixture-book/')],
      [element(f.workUrl.replace('fixture-book', 'other-book'))], [element(f.workUrl + 'chapter-2/')]]) {
      f.elements.canonical = links;
      expect(f.read().status).toBe('not-ready');
    }
  });
  it('does not fall back to chapter headings, OG titles or a chapter list when the work link is missing', () => {
    const f = fixture(site, true);
    f.elements.links = [];
    expect(f.read().status).toBe('not-ready');
    expect(f.document.querySelectorAll.mock.calls.map(([selector]) => selector)).toEqual(['link[rel="canonical"]', '.c-breadcrumb .breadcrumb a[href]']);
  });
  it('rejects a mismatched source identity, catalog binding and an aborted document', () => {
    const f = fixture(site);
    f.context.location = {...f.context.location, sourceId: 'other'};
    expect(f.read().status).toBe('not-ready');
    f.context.location = {...f.context.location, sourceId: site.definition.id, catalog: {key: 'wrong', url: f.workUrl}};
    expect(f.read().status).toBe('not-ready');
    f.controller.abort(Error('stale document'));
    expect(f.read).toThrow('stale document');
  });
});
