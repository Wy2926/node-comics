import {expect, it} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {reader, url} from './fixtures';

it('mounts catalog and reader entries while discovery stays HTTP-only, and expires navigated sessions', async () => {
  let selected = '';
  const anchor = {} as Element;
  const doc = {title: 'Fixture', querySelector: (selector: string) => {selected = selector; return anchor;}} as unknown as Document;
  const navigation = createSourceNavigation(doc), first = navigation.get(url).session;
  expect(first.importAnchor?.()).toBe(anchor);
  expect(selected).toBe('.cinema-info .hero-actions');
  expect(await first.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
  expect(first.inlineTargets()).toEqual([]);
  const next = navigation.get(reader).session;
  expect(next.importAnchor?.()).toBe(anchor);
  expect(selected).toBe('.reader-finish-actions');
  expect(() => first.importAnchor?.()).toThrow();
  navigation.dispose();
  expect(() => next.snapshot()).toThrow();
});
