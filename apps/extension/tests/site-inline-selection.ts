import {describe, expect, it} from 'vitest';
import {createSourceNavigation} from '../src/sources/page';
import {sourceFor} from '../src/sources';

/** Shared DOM contract checks; selectors and supported URLs remain in each site's tests. */
export function verifyImageSelection({url, catalogUrl, selector, ids}: {url: string; catalogUrl: string; selector: string; ids: string[]}) {
  describe('adapted inline originals', () => {
    function fixture() {
      const images = ids.map(id => ({id, currentSrc: '', src: 'https://images.example/same.png',
        complete: true, naturalWidth: 760, naturalHeight: 60, width: 760, height: 60}));
      const doc = {title: 'Fixture', querySelector: () => null,
        querySelectorAll: (query: string) => {expect(query).toBe(selector); return images;}} as unknown as Document;
      const navigation = createSourceNavigation(doc), session = navigation.get(url).session;
      return {images, navigation, session};
    }
    it('recognizes short slices, preserves duplicates and excludes unloaded/broken originals', () => {
      const {images, session} = fixture();
      expect(sourceFor(url).definition.capabilities.inline).toBe(true);
      expect(session.inlineTargets().map(target => target.element)).toEqual(images);
      images[0].complete = false; expect(session.inlineTargets()).toHaveLength(images.length - 1);
      images[0].complete = true; images[0].naturalWidth = 0; expect(session.inlineTargets()).toHaveLength(images.length - 1);
      images[0].naturalWidth = 760; images[0].src = 'https://images.example/next.png';
      expect(session.inlineTargets()[0].url).toBe(images[0].src);
    });
    it('does not scan catalog or unsupported pages, and expires old sessions after navigation', () => {
      const {session, navigation} = fixture();
      expect(navigation.get(catalogUrl).session.inlineTargets()).toEqual([]);
      expect(() => session.inlineTargets()).toThrow();
      expect(navigation.get(new URL('/', url).href).session.inlineTargets()).toEqual([]);
      navigation.dispose();
    });
  });
}
