import {describe, expect, it} from 'vitest';
import {createPage} from '../page';
import {catalogUrl, chapterUrl, definition} from '../definition';

const reader = chapterUrl('Work1', 'Chap1'), source = 'https://cdn.atsu.moe/static/pages/Work1/Chap1/0.webp';
function session(document: Document, url = reader, signal = new AbortController().signal) {
  return createPage({document, location: definition.identify(new URL(url))!, signal});
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
  it('returns only work-page metadata and leaves complete acquisition to HTTP', async () => {
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
});
