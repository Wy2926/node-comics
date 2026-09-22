import { expect, it, vi } from 'vitest';
import { definition } from '../definition';
import { createPage } from '../page';
it('uses only the comic selector and declares one loaded panel complete', async () => {
  const image = {
    src: 'https://imgs.xkcd.com/comics/sample.png',
    dataset: {},
    naturalWidth: 800,
    naturalHeight: 600,
  };
  const querySelectorAll = vi.fn(() => [image]),
    url = new URL('https://xkcd.com/1/');
  const session = createPage({
    document: { title: 'Sample', querySelectorAll } as unknown as Document,
    location: definition.identify(url)!,
    signal: new AbortController().signal,
  });
  expect(await session.discoverPages()).toMatchObject({
    status: 'ready',
    value: { discoveryComplete: true, knownTotal: 1, direction: 'ltr' },
  });
  expect(session.inlineTargets()[0].element).toBe(image);
  expect(querySelectorAll).toHaveBeenCalledWith('#comic img');
  session.dispose();
});
