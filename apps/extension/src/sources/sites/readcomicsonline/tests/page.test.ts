import {expect, it, vi} from 'vitest';
import {definition} from '../definition';
import {describeWork} from '../page';
import {readerUrl, title, workUrl} from './fixtures';

it('hands off a verified work title without reading images or fetching the catalog', () => {
  const element = (href: string, textContent = '') => ({textContent, getAttribute: () => href});
  const nodes: Record<string, unknown[]> = {'link[rel="canonical"]': [element(readerUrl)],
    'nav[aria-label="Breadcrumb"] a[href]': [element('https://readcomicsonline.ru', 'Home'), element(workUrl, title)],
    'main h1': [element('', title)]};
  const querySelectorAll = vi.fn((selector: string) => nodes[selector]);
  const controller = new AbortController(), context = {document: {querySelectorAll} as unknown as Document,
    location: definition.identify(new URL(readerUrl + '/2'))!, signal: controller.signal};
  expect(describeWork(context)).toMatchObject({status: 'ready', value: {title, catalogUrl: workUrl}});
  expect(querySelectorAll).toHaveBeenCalledTimes(2);
  nodes['link[rel="canonical"]'] = [element(workUrl)];
  expect(describeWork(context).status).toBe('not-ready');
  const catalogContext = {...context, location: definition.identify(new URL(workUrl))!};
  expect(describeWork(catalogContext)).toMatchObject({status: 'ready', value: {title}});
  nodes['main h1'].push(element('', 'Conflicting title'));
  expect(describeWork(catalogContext).status).toBe('not-ready');
  nodes['link[rel="canonical"]'] = [element(readerUrl)];
  nodes['nav[aria-label="Breadcrumb"] a[href]'] = [element(workUrl + '/2', 'Chapter 2')];
  expect(describeWork(context).status).toBe('not-ready');
  nodes['nav[aria-label="Breadcrumb"] a[href]'] = [element(workUrl, 'Updated work')];
  expect(describeWork(context)).toMatchObject({status: 'ready', value: {title: 'Updated work'}});
  nodes['link[rel="canonical"]'] = [element(workUrl + '/2')];
  expect(describeWork(context).status).toBe('not-ready');
  expect(describeWork({...context, location: {...context.location, sourceId: 'other'}}).status).toBe('not-ready');
  controller.abort(); expect(() => describeWork(context)).toThrow();
});
