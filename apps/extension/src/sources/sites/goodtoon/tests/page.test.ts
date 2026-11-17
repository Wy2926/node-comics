import {expect, it, vi} from 'vitest';
import {definition, origin} from '../definition';
import {describeWork} from '../page';
import {readerUrl, workUrl} from './fixtures';

it.each([origin, 'https://www.goodtoon012.com'])('hands off the canonical work on %s without fetching a chapter list', base => {
  const work = workUrl.replace(origin, base), reader = readerUrl.replace(origin, base);
  const element = (href: string, textContent = '') => ({textContent, getAttribute: () => href});
  const nodes: Record<string, unknown[]> = {'link[rel="canonical"]': [element(reader)],
    'h1.reader-title-manga': [element('', '테스트 작품')], 'a.reader-ctl[href]': [element(work)]};
  const querySelectorAll = vi.fn((selector: string) => nodes[selector]);
  const controller = new AbortController(), context = {document: {querySelectorAll} as unknown as Document,
    location: definition.identify(new URL(reader))!, signal: controller.signal};
  expect(describeWork(context)).toMatchObject({status: 'ready', value: {title: '테스트 작품', catalogUrl: work}});
  nodes['link[rel="canonical"]'] = [element(work)];
  expect(describeWork(context).status).toBe('not-ready');
  nodes['link[rel="canonical"]'] = [element(reader)]; nodes['a.reader-ctl[href]'] = [];
  expect(describeWork(context).status).toBe('not-ready');
  controller.abort(); expect(() => describeWork(context)).toThrow();
});
