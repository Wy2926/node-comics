import { describe, expect, it } from 'vitest';
import { sameSourcePage, sourceFor, sourcePageIdentity } from '../../../index';
import { discoverDocument } from '../../../page';
import { isMangaCopyUrl, mangaCopyLocation } from '../definition';
describe('shared MangaCopy domains', () => {
  it.each(['mangacopy.com', 'www.mangacopy.com', 'copy4000.com', 'www.copy4000.com'])(
    'recognizes %s and shares the source identity',
    (host) => {
      const url = `https://${host}/comic/sample/chapter/724f819b-5306-11ea-b7ea-024352452ce0`;
      expect(mangaCopyLocation(url)).toEqual({
        slug: 'sample',
        chapterId: '724f819b-5306-11ea-b7ea-024352452ce0',
      });
      expect(sourcePageIdentity(url)).toBe(sourcePageIdentity(url.replace(host, 'www.mangacopy.com')));
      const img = {
        getAttribute: (name: string) => (name === 'data-src' ? 'https://images.example/1' : null),
      };
      const doc = {
        title: '漫画',
        querySelector: () => ({ textContent: '1' }),
        querySelectorAll: () => [img],
      } as unknown as Document;
      expect(discoverDocument(doc, url)).toMatchObject({
        adapter: 'mangacopy',
        discoveryComplete: true,
        knownTotal: 1,
      });
      expect(sourceFor(`https://${host}/comic/sample`).location.catalog).toEqual({
        key: 'mangacopy:sample',
        url: `https://${host}/comic/sample`,
      });
    },
  );
  it.each([
    'https://copy4000.com.evil.test/comic/sample',
    'https://evilcopy4000.com/comic/sample',
    'https://user@copy4000.com/comic/sample',
    'http://copy4000.com/comic/sample',
    'https://copy4000.com:8080/comic/sample',
  ])('rejects an unrelated or unsafe origin %s', (url) => expect(isMangaCopyUrl(url)).toBe(false));
  it('allows only the same content across mirror redirects', () => {
    const url = 'https://www.mangacopy.com/comic/sample/chapter/724f819b-5306-11ea-b7ea-024352452ce0';
    expect(sameSourcePage(url, url.replace('www.mangacopy.com', 'copy4000.com'))).toBe(true);
    expect(sameSourcePage(url, url.replace('sample', 'another'))).toBe(false);
    expect(sameSourcePage(url, 'https://copy4000.com/comic/sample')).toBe(false);
    expect(sameSourcePage(url, url.replace('www.mangacopy.com', 'evil.test'))).toBe(false);
  });
});
