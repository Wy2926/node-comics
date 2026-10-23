import {expect, it, vi} from 'vitest';
import {definition} from '../definition';
import {describeWork} from '../page';
import {readerUrl, workUrl} from './fixtures';

it('hands off only the current canonical work name, without fetching a chapter list', () => {
  const element = (href: string, textContent = '') => ({textContent, getAttribute: () => href});
  const nodes: Record<string, unknown[]> = {'link[rel="canonical"]': [element(readerUrl)],
    'h1.reader-title-manga': [element('', '테스트 작품')], 'a.reader-ctl[href]': [element(workUrl)]};
  const querySelectorAll = vi.fn((selector: string) => nodes[selector]);
  const controller = new AbortController(), context = {document: {querySelectorAll} as unknown as Document,
    location: definition.identify(new URL(readerUrl))!, signal: controller.signal};
  expect(describeWork(context)).toMatchObject({status: 'ready', value: {title: '테스트 작품', catalogUrl: workUrl}});
  nodes['link[rel="canonical"]'] = [element(workUrl)];
  expect(describeWork(context).status).toBe('not-ready');
  nodes['link[rel="canonical"]'] = [element(readerUrl)]; nodes['a.reader-ctl[href]'] = [];
  expect(describeWork(context).status).toBe('not-ready');
  controller.abort(); expect(() => describeWork(context)).toThrow();
});
