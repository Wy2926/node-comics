import {describe, expect, it} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {catalogUrl, chapterUrl} from '../definition';
import {mangaId, uuid} from './fixtures';

describe('MangaDex page import host', () => {
  it('mounts one owned page-level action, uses HTTP discovery and cleans up on navigation/disposal', async () => {
    const children: object[] = [];
    const doc = {title: 'Fixture', body: {append: (child: {isConnected: boolean}) => {children.push(child); child.isConnected = true;}},
      createElement: () => {const element = {dataset: {}, style: {}, isConnected: false, remove() {this.isConnected = false; const i = children.indexOf(this); if (i >= 0) children.splice(i, 1);}}; return element;}} as unknown as Document;
    const navigation = createSourceNavigation(doc), first = navigation.get(catalogUrl(mangaId)).session;
    const anchor = first.importAnchor?.();
    expect(anchor).toBeTruthy();
    expect(first.importAnchor?.()).toBe(anchor);
    expect(children).toHaveLength(1);
    expect(await first.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
    expect(first.inlineTargets()).toEqual([]);
    const next = navigation.get(chapterUrl(uuid(1))).session;
    expect(children).toHaveLength(0);
    expect(() => first.importAnchor?.()).toThrow();
    expect(next.importAnchor?.()).not.toBe(anchor);
    expect(children).toHaveLength(1);
    navigation.dispose();
    expect(children).toHaveLength(0);
    expect(() => next.importAnchor?.()).toThrow();
  });
  it('does not mount on other MangaDex pages', () => {
    const navigation = createSourceNavigation({title: '', body: {}} as Document);
    expect(navigation.get('https://mangadex.org/search').session.importAnchor?.()).toBeNull();
    navigation.dispose();
  });
});
