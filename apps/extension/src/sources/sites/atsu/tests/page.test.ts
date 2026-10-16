import {describe, expect, it} from 'vitest';
import {createPage} from '../page';
import {catalogUrl, chapterUrl, definition} from '../definition';

const reader = chapterUrl('Work1', 'Chap1'), source = 'https://cdn.atsu.moe/static/pages/Work1/Chap1/0.webp';
function session(document: Document, url = reader, signal = new AbortController().signal) {
  return createPage({document, location: definition.identify(new URL(url))!, signal});
}
function workDocument({canonical, title, headings = [], links = []}: {
  canonical?: string; title?: string; headings?: string[]; links?: {href: string; title: string; nestedTitle?: string}[];
}) {
  const meta: Record<string, string | undefined> = {'og:url': canonical, 'og:title': title};
  return {title: 'Chapter 1 - not the work title',
    querySelector: (selector: string) => {
      if (!selector.startsWith('a[')) return {getAttribute: () => meta[/og:\w+/.exec(selector)![0]]};
      const prefixes = [...selector.matchAll(/\[href\^="([^"]+)"\]/g)].map(match => match[1]);
      const link = links.find(link => prefixes.some(prefix => link.href.startsWith(prefix)));
      return link ? {getAttribute: () => link.href} : null;
    },
    querySelectorAll: (selector: string) => selector === 'h1' ? headings.map(textContent => ({textContent})) :
      selector.startsWith('a[') ? links.filter(link => selector.split(',').includes(`a[href="${link.href}"]`)).map(link => ({textContent: link.title,
        querySelector: (nested: string) => nested === 'span.text-ellipsis' && link.nestedTitle !== undefined ? {textContent: link.nestedTitle} : null})) : [],
  } as unknown as Document;
}
describe('Atsumaru page sessions', () => {
  it('selects loaded reader images, keeps duplicate URLs separate, and excludes foreign or stale ownership', () => {
    const image = (number: string, src = source, complete = true) => ({src, complete, naturalWidth: 800, naturalHeight: 1200,
      closest: () => ({getAttribute: () => number})});
    const images = [image('0'), image('1'), image('2', source, false), image('3', 'https://evil.test/page.webp'),
      image('4', source.replace('Chap1', 'Other')), image('5', 'blob:https://atsu.moe/fixture'), image('6', 'blob:https://evil.test/fixture'), image('bad'),
      image('7', source.replace('Work1', 'Scan1'))];
    const document = {title: '', querySelectorAll: () => images} as unknown as Document;
    const page = session(document), targets = page.inlineTargets();
    expect(targets).toHaveLength(4); expect(targets[0].key).not.toBe(targets[1].key);
    expect(session(document, catalogUrl('Work1')).inlineTargets()).toEqual([]);
    page.dispose(); expect(() => page.inlineTargets()).toThrow('SOURCE_SESSION_EXPIRED');
  });
  it('accepts matching work metadata and leaves complete acquisition to HTTP', async () => {
    const meta: Record<string, string> = {'og:url': catalogUrl('Work1'), 'og:title': 'Fixture work'};
    const document = {title: 'Reader title', querySelectorAll: () => [], querySelector: (selector: string) => ({getAttribute: () => meta[/og:\w+/.exec(selector)![0]]})} as unknown as Document;
    const page = session(document, catalogUrl('Work1'));
    expect(page.describeWork?.()).toEqual({status: 'ready', value: {title: 'Fixture work', catalogId: 'atsu:Work1', catalogUrl: catalogUrl('Work1')}});
    meta['og:url'] = catalogUrl('Other'); expect(page.describeWork?.().status).toBe('not-ready');
    const readerPage = session(document); expect(readerPage.describeWork?.().status).toBe('not-ready');
    expect(await readerPage.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
    const controller = new AbortController(), cancelled = session(document, reader, controller.signal); controller.abort();
    expect(() => cancelled.inlineTargets()).toThrow(); expect(() => cancelled.snapshot()).toThrow();
  });
  it('recognizes a hydrated work page whose og:url has reset to the site root', () => {
    const links = [{href: '/read/Work1/Chap1', title: 'Start readingStart'}];
    const document = workDocument({canonical: 'https://atsu.moe/', title: 'Fixture work', headings: ['Fixture work', ' Fixture\nwork '], links});
    expect(session(document, catalogUrl('Work1')).describeWork?.()).toEqual({status: 'ready', value: {
      title: 'Fixture work', catalogId: 'atsu:Work1', catalogUrl: catalogUrl('Work1'),
    }});
    for (const headings of [[], ['Other work'], ['Fixture work', 'Other work'], Array(9).fill('Fixture work')]) {
      expect(session(workDocument({canonical: 'https://atsu.moe/', title: 'Fixture work', headings, links}), catalogUrl('Work1'))
        .describeWork?.().status).toBe('not-ready');
    }
    for (const canonical of [catalogUrl('Other'), 'https://atsu.moe.evil.test/manga/Work1']) {
      expect(session(workDocument({canonical, title: 'Fixture work', headings: ['Fixture work'], links}), catalogUrl('Work1'))
        .describeWork?.().status).toBe('not-ready');
    }
    expect(session(document, catalogUrl('OtherWork')).describeWork?.().status).toBe('not-ready');
  });
  it('requires a valid current-work reader link before using root or missing work metadata', () => {
    for (const canonical of [undefined, 'https://atsu.moe', 'https://atsu.moe/']) {
      for (const href of ['/read/Work1/Chap1', reader]) {
        expect(session(workDocument({canonical, title: 'Fixture work', headings: ['Fixture work'],
          links: [{href, title: 'Start'}]}), catalogUrl('Work1')).describeWork?.().status).toBe('ready');
      }
      for (const links of [[], [{href: '/read/Other/Chap1', title: 'Start'}],
        [{href: 'https://atsu.moe.evil.test/read/Work1/Chap1', title: 'Start'}],
        [{href: '/read/Work1/Chap1/extra', title: 'Start'}], [{href: '/read/Work1/', title: 'Start'}]]) {
        expect(session(workDocument({canonical, title: 'Fixture work', headings: ['Fixture work'], links}), catalogUrl('Work1'))
          .describeWork?.().status).toBe('not-ready');
      }
    }
  });
  it('uses the search seed Unicode title budget without truncating names', () => {
    for (const title of ['x'.repeat(2000), '😀'.repeat(2000)]) {
      expect(session(workDocument({canonical: catalogUrl('Work1'), title}), catalogUrl('Work1')).describeWork?.().status).toBe('ready');
      expect(session(workDocument({links: [{href: '/manga/Work1', title}]})).describeWork?.().status).toBe('ready');
    }
    for (const title of ['x'.repeat(2001), '😀'.repeat(2001)]) {
      expect(session(workDocument({canonical: catalogUrl('Work1'), title}), catalogUrl('Work1')).describeWork?.().status).toBe('not-ready');
      expect(session(workDocument({links: [{href: '/manga/Work1', title}]})).describeWork?.().status).toBe('not-ready');
    }
  });
  it('uses exact parent work links, excluding empty icons, navigation card labels and chapter metadata', () => {
    const document = workDocument({title: 'Chapter 1', links: [
      {href: '/manga/Work1', title: ''}, {href: '/manga/Work1', title: ' Fixture\nwork '},
      {href: '/manga/Work1', title: 'Manhua InfoFixture work', nestedTitle: 'Fixture work'},
      {href: '/manga/Other', title: 'Recommended work'},
    ]});
    expect(session(document).describeWork?.()).toEqual({status: 'ready', value: {
      title: 'Fixture work', catalogId: 'atsu:Work1', catalogUrl: catalogUrl('Work1'),
    }});
    for (const href of ['/manga/Work1/', catalogUrl('Work1'), catalogUrl('Work1') + '/']) {
      expect(session(workDocument({links: [{href, title: 'Fixture work'}]})).describeWork?.().status).toBe('ready');
    }
    // Reusing a document after a SPA route change must not attach the previous work name.
    expect(session(document, chapterUrl('OtherWork', 'Chap2')).describeWork?.().status).toBe('not-ready');
  });
  it('rejects missing, ambiguous, malformed or foreign work links without guessing from chapter titles', () => {
    for (const links of [[], [{href: '/manga/Work1', title: ''}], [{href: '/manga/Other', title: 'Other work'}],
      [{href: 'https://atsu.moe.evil.test/manga/Work1', title: 'Other work'}],
      [{href: '/read/Work1/Chap1', title: 'Chapter 1'}],
      [{href: '/manga/Work1', title: 'Fixture work'}, {href: '/manga/Work1', title: 'Other title'}],
      [{href: '/manga/Work1', title: 'Fixture work'}, {href: '/manga/Work1', title: 'Manhua InfoOther work', nestedTitle: 'Other work'}],
      [{href: '/manga/Work1', title: 'Bad\u0000title'}],
      Array(9).fill({href: '/manga/Work1', title: 'Fixture work'})]) {
      expect(session(workDocument({canonical: catalogUrl('Work1'), title: 'Chapter 1', links})).describeWork?.().status).toBe('not-ready');
    }
  });
  it('does not describe a work after the page session is cancelled or disposed', () => {
    const document = workDocument({links: [{href: '/manga/Work1', title: 'Fixture work'}]});
    const page = session(document); page.dispose(); expect(() => page.describeWork?.()).toThrow('SOURCE_SESSION_EXPIRED');
    const controller = new AbortController(), cancelled = session(document, reader, controller.signal); controller.abort();
    expect(() => cancelled.describeWork?.()).toThrow();
  });
});
