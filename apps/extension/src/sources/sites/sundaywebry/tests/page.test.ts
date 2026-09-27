import {expect, it} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {episodeUrl} from '../definition';
import {imageUrl, readerData} from './fixtures';

it('maps loaded main canvases to HTTP originals, excludes unrendered pages, and invalidates changed source metadata', async () => {
  let data = readerData();
  const first = {width: 67, height: 99, isConnected: true}, second = {width: 0, height: 0, isConnected: true};
  const areas = [first, second].map(element => ({querySelector: () => element}));
  const doc = {title: 'chapter title', querySelector: () => ({getAttribute: () => JSON.stringify(data)}), querySelectorAll: () => areas} as unknown as Document;
  const navigation = createSourceNavigation(doc), session = navigation.get(episodeUrl('11')).session;
  expect(session.inlineTargets().map(target => target.url)).toEqual([imageUrl]);
  Object.assign(second, {width: 67, height: 99});
  const targets = session.inlineTargets(); expect(targets).toHaveLength(2); expect(targets[0].key).not.toBe(targets[1].key);
  expect(session.describeWork?.()).toMatchObject({status: 'ready', value: {title: 'テスト作品', catalogId: 'sundaywebry:series:7'}});
  expect(await session.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
  data = readerData('12'); expect(session.inlineTargets()).toEqual([]); expect(session.describeWork?.().status).toBe('not-ready');
  navigation.get(episodeUrl('12')); expect(() => session.inlineTargets()).toThrow(); navigation.dispose();
});
it('checks element and session lifetime around unscrumbled page-bound reads', async () => {
  const data = readerData(); data.readableProduct.pageStructure.choJuGiga = 'usagi';
  const element = {width: 67, height: 99, isConnected: true, toBlob: (cb: (blob: Blob) => void) => cb(new Blob(['image']))};
  const doc = {title: '', querySelector: () => ({getAttribute: () => JSON.stringify(data)}),
    querySelectorAll: () => [{querySelector: () => element}, {querySelector: () => null}]} as unknown as Document;
  const navigation = createSourceNavigation(doc), session = navigation.get(episodeUrl('11')).session;
  const target = session.inlineTargets()[0]; expect(await target.read!()).toBeInstanceOf(Blob);
  element.isConnected = false; await expect(target.read!()).rejects.toThrow('EXPIRED');
  element.isConnected = true; navigation.dispose(); await expect(target.read!()).rejects.toThrow();
});
