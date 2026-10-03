import {afterEach, describe, expect, it, vi} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {definition, mangaOneChapter, origin} from '../definition';
import {bodySelector} from '../page';

const url = origin + '/manga/659/chapter/359725';
afterEach(() => vi.unstubAllGlobals());
function image(alt: string, src = 'blob:' + origin + '/first', extra = {}) {
  return {tagName: 'IMG', className: 'fixture_page', alt, src, currentSrc: '', complete: true, naturalWidth: 720, naturalHeight: 1020,
    ...extra} as unknown as HTMLImageElement;
}
function fixture() {
  let images = [image('page_0'), image('page_1')];
  const doc = {title: 'Chapter', querySelectorAll: (selector: string) => selector === bodySelector ? images : []} as unknown as Document;
  const navigation = createSourceNavigation(doc), session = navigation.get(url).session;
  return {session, navigation, set: (next: HTMLImageElement[]) => {images = next;}};
}
describe('Manga One explicit inline adapter', () => {
  it('is registered, recognizes chapter identity and never advertises complete imports', async () => {
    expect(fixture().navigation.get(url).location.sourceId).toBe('mangaone');
    expect(mangaOneChapter(new URL(url))).toEqual({work: '659', chapter: '359725'});
    expect(definition.identify(new URL(url + '?from=home#page=2'))?.pageKey).toBe('mangaone:659:359725');
    expect(definition.capabilities).toEqual({pages: false, inline: true, catalog: false, completePageList: false});
    expect(definition.catalogSync).toBeUndefined();
    const {session} = fixture();
    expect(session.snapshot()).toMatchObject({items: [], discoveryComplete: false});
    expect(await session.discoverPages()).toEqual({status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'});
  });
  it.each(['http://manga-one.com', 'https://manga-one.com.evil.test', 'https://app.manga-one.com',
    'https://manga-one.com:444', 'https://user:pass@manga-one.com'])('rejects host or credential spoof %s', host => {
    expect(definition.identify(new URL(host + '/manga/659/chapter/359725'))).toBeNull();
  });
  it.each(['/manga/659', '/manga/659/chapter/0', '/manga/659/chapter/0359725',
    '/manga/659/chapter/359725/extra', '/manga/659/chapter/%31', '/search', '/'])('does not translate unrelated path %s', path => {
    expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
    const {navigation} = fixture();
    expect(navigation.get(origin + path).session.inlineTargets()).toEqual([]);
  });
  it('keeps duplicate Blobs as distinct elements and survives translated alt text while invalidating changed Blobs', () => {
    const {session, set} = fixture();
    const initial = session.inlineTargets();
    expect(initial).toHaveLength(2);
    expect(initial[0].url).toBe(initial[1].url);
    expect(initial[0].element).not.toBe(initial[1].element);
    const recycled = initial[0].element as HTMLImageElement;
    recycled.alt = '第0页'; set([recycled]);
    const next = session.inlineTargets()[0];
    expect(next.key).toBe(initial[0].key);
    recycled.src = 'blob:' + origin + '/next';
    expect(session.inlineTargets()[0].key).not.toBe(next.key);
    expect(session.inlineTargets()[0].read).toBeTypeOf('function'); // shared Blob transport, no site decoder
  });
  it('excludes HTTP ciphertext, foreign/data images, non-page classes and incomplete images', () => {
    const {session, set} = fixture();
    set([image('page_0'), image('page_1', 'https://app.manga-one.com/encrypted'),
      image('page_2', 'blob:https://evil.test/image'), image('page_3', 'data:image/png;base64,AA=='),
      image('cover', undefined, {className: 'fixture_cover'}), image('page_01', undefined, {className: 'fixture_page_overlay'}),
      image('page_4', undefined, {complete: false}),
      image('page_5', undefined, {naturalWidth: 0}), image('page_6', undefined, {naturalHeight: 0})]);
    expect(session.inlineTargets().map(t => (t.element as HTMLImageElement).alt)).toEqual(['page_0']);
  });
  it('handles late loading and invalidates sessions on navigation, disposal and abort', () => {
    const {session, navigation, set} = fixture();
    const lazy = image('page_2', undefined, {complete: false}); set([lazy]);
    expect(session.inlineTargets()).toEqual([]);
    Object.defineProperty(lazy, 'complete', {value: true});
    expect(session.inlineTargets()).toHaveLength(1);
    navigation.get(origin + '/manga/659/chapter/359726');
    expect(() => session.inlineTargets()).toThrow();
    const fresh = navigation.get(url).session; fresh.dispose();
    expect(() => fresh.inlineTargets()).toThrow('SOURCE_SESSION_EXPIRED');
  });
});
