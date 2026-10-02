import {describe, expect, it} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {catalogUrl, chapterUrl} from '../definition';
import {chapterId, image, otherTitleId, secondChapterId, titleId} from './fixtures';

describe('MangaBall page metadata and loaded original targets', () => {
  it('reads reliable work metadata, excludes chapter headings, and expires navigation sessions', async () => {
    const meta = {canonical: catalogUrl(titleId) + '-fixture-work', title: 'Read Fixture work Online Free - MangaBall'};
    const doc = {title: 'Source document', querySelectorAll: () => [], querySelector: (selector: string) => ({getAttribute: () => selector.startsWith('link') ? meta.canonical : meta.title})} as unknown as Document;
    const navigation = createSourceNavigation(doc), session = navigation.get(catalogUrl(titleId)).session;
    expect(session.describeWork?.()).toEqual({status: 'ready', value: {title: 'Fixture work', catalogId: 'mangaball:' + titleId, catalogUrl: catalogUrl(titleId)}});
    meta.title = 'Unexpected chapter heading'; expect(session.describeWork?.().status).toBe('not-ready');
    const reader = navigation.get(chapterUrl(chapterId, titleId)).session;
    expect(() => session.inlineTargets()).toThrow(); expect(reader.describeWork?.().status).toBe('not-ready');
    expect(await reader.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
    navigation.dispose(); expect(() => reader.inlineTargets()).toThrow();
  });
  it('keeps separate duplicate images and excludes covers, advertisements and unloaded pages', () => {
    const img = (alt: string, src: string, complete = true) => ({alt, src, complete, naturalWidth: 800, naturalHeight: 1200, getAttribute: () => alt});
    const doc = {title: '', querySelectorAll: () => [img('Fixture work Chapter 1 Page 1 - English', image), img('Fixture work Chapter 1 Page 2 - English', image),
      img('Fixture work Chapter 1 Page 3 - English', image, false), img('Cover', image), img('Advertisement', image), img('Fixture work Chapter 1 Page 4 - English', image.replace(chapterId, titleId)),
      img('Fixture work Chapter 1 Page 5 - English', image.replace('/storage/', '/covers/'))]} as unknown as Document;
    const navigation = createSourceNavigation(doc), session = navigation.get(chapterUrl(chapterId, titleId)).session;
    const targets = session.inlineTargets(); expect(targets).toHaveLength(4); expect(targets[0].key).not.toBe(targets[1].key);
    expect(navigation.get(catalogUrl(titleId)).session.inlineTargets()).toEqual([]); navigation.dispose();
  });
  it('accepts loaded source DOM images on any public HTTP(S) server without filename or breadcrumb checks', () => {
    const ordinal = `https://bulbasaur.poke-black-and-white.net/storage/${titleId}/0/1.1/mangadex/en/001.webp`;
    const original = {alt: 'Fixture work Chapter 1.1 Page 1 - English', src: ordinal, complete: true,
      naturalWidth: 1319, naturalHeight: 2000, getAttribute() {return this.alt;}};
    const doc = {title: '', querySelectorAll: () => [original]} as unknown as Document;
    const navigation = createSourceNavigation(doc), session = navigation.get(chapterUrl(chapterId)).session;
    expect(session.inlineTargets()).toHaveLength(1);
    const firstKey = session.inlineTargets()[0].key;
    for (const src of [ordinal.replace(titleId, otherTitleId), ordinal.replace('/1.1/', '/2/'), ordinal.replace('/001.webp', '/002.webp'),
      ordinal.replace('/en/', '/es/'), 'https://another-cdn.example/comic/custom-file.png?format=webp', 'http://another-cdn.example:8080/1.webp#page']) {
      original.src = src; expect(session.inlineTargets()).toHaveLength(1); expect(session.inlineTargets()[0].key).not.toBe(firstKey);
    }
    original.src = ordinal;
    for (const alt of ['Advertisement', 'Cover', 'Fixture work page']) {
      original.alt = alt; expect(session.inlineTargets()).toEqual([]);
    }
    for (const alt of ['Fixture work Chapter 2 Page 1 - English', 'Fixture work Chapter 1.1 Page 2 - English', 'Fixture work Chapter 1.1 Page 1 - Spanish']) {
      original.alt = alt; expect(session.inlineTargets()).toHaveLength(1); expect(session.inlineTargets()[0].key).not.toBe(firstKey);
    }
    original.alt = 'Fixture work Chapter 1.1 Page 1 - English'; original.src = ordinal;
    for (const src of ['javascript:alert(1)', 'file:///comic.png', 'https://user:password@another-cdn.example/1.png']) {
      original.src = src; expect(session.inlineTargets()).toEqual([]);
    }
    original.src = ordinal;
    original.complete = false; expect(session.inlineTargets()).toEqual([]); original.complete = true;
    original.naturalWidth = 0; expect(session.inlineTargets()).toEqual([]); original.naturalWidth = 1319;
    expect(navigation.get(chapterUrl(secondChapterId)).session.inlineTargets()).toHaveLength(1);
    expect(() => session.inlineTargets()).toThrow(); navigation.dispose();
  });
});
