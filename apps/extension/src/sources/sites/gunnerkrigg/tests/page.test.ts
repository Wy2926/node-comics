import { expect, it, vi } from 'vitest';
import { definition } from '../definition';
import { createPage } from '../page';
it('waits for its own panel, excludes ads and retains the page query identity', async () => {
  const url = new URL('https://www.gunnerkrigg.com/?p=123'),
    querySelectorAll = vi.fn(() => []);
  const location = definition.identify(url)!;
  const session = createPage({
    document: { title: 'Sample', querySelectorAll } as unknown as Document,
    location,
    signal: new AbortController().signal,
  });
  expect(await session.discoverPages()).toMatchObject({
    status: 'not-ready',
    partial: { discoveryComplete: false, items: [] },
  });
  expect(querySelectorAll).toHaveBeenCalledWith('img.comic_image, #comic img');
  expect(location.pageKey).not.toBe(
    definition.identify(new URL('https://www.gunnerkrigg.com/?p=124'))!.pageKey,
  );
  session.dispose();
});
