import {describe, expect, it} from 'vitest';
import type {SourceNetwork} from '../src/sources/contracts/network';
import {network as readcomicsonline} from '../src/sources/sites/readcomicsonline/network';
import {network as hachiraw} from '../src/sources/sites/hachiraw/network';
import {network as mangaball} from '../src/sources/sites/mangaball/network';
import {network as mangapill} from '../src/sources/sites/mangapill/network';
import {network as webtoonscan} from '../src/sources/sites/webtoonscan/network';

describe('explicit search page selection', () => {
  it.each(Object.entries({readcomicsonline, hachiraw, mangaball, mangapill, webtoonscan}))('%s selects the actual query origin for both first and subsequent pages', async (siteId, network: SourceNetwork) => {
    for (const cursor of [undefined, 'page:2']) {
      const input = {siteId, query: 'One & 日本語', cursor};
      let requested: string | undefined;
      await network.search!(input, {request: async url => {requested = url; throw Error('stop before network');}}).catch(() => {});
      expect(network.searchPage!(input)).toBe(requested);
      if (siteId === 'mangaball') expect(new URL(requested!).origin).toBe('https://api.mangaball.com');
    }
  });
});
