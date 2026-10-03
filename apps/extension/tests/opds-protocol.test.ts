import { describe, expect, it } from 'vitest';
import {
  expandSearch,
  isBitmap,
  jsonPublication,
  parseCatalog,
  parsePublication,
  parseSearchDescription,
} from '../src/comics/sources/opds/protocol';
import { publicationAccess, safePse } from '../src/comics/sources/opds/publication-access';
import { identityUrl, type PrivateConnection } from '../src/comics/sources/opds/private-store';
import { installTestXmlParser } from './opds-protocol-dom';

installTestXmlParser();

const root = 'https://catalog.example/opds/root';
const entry = (extra: string) =>
  `<entry><id>urn:book:1</id><title>Book &amp; 1</title>${extra}</entry>`;
const feed = (inside: string) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>Library</title>${inside}</feed>`;
describe('OPDS protocol normalization', () => {
  it('preserves namespaced Atom, xml:base, relative links and entry identity', () => {
    const result = parseCatalog(
      `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="../"><a:title>Library</a:title><a:entry xml:base="books/"><a:id>urn:book:7</a:id><a:title>One</a:title><a:link rel="http://opds-spec.org/acquisition" type="application/zip" href="7.cbz"/></a:entry></a:feed>`,
      root,
    );
    expect(result.protocol).toBe('opds1');
    expect(result.publications[0].identity).toBe('urn:book:7');
    expect(result.publications[0].links[0].href).toBe('https://catalog.example/books/7.cbz');
  });
  it('separates navigation from partial entries and keeps facets/pagination', () => {
    const result = parseCatalog(
      feed(
        `<link rel="next" href="?page=2"/><link rel="http://opds-spec.org/facet" title="New" opds:facetGroup="Order" opds:activeFacet="true" href="?order=new"/>${entry('<link type="application/atom+xml;type=entry;profile=opds-catalog" rel="alternate" href="book/1"/>')}<entry><id>nav</id><title>Series</title><link type="application/atom+xml" href="series"/></entry>`,
      ),
      root,
    );
    expect(result.publications).toHaveLength(1);
    expect(result.publications[0].title).toBe('Book & 1');
    expect(result.navigation[0].title).toBe('Series');
    expect(result.facets[0]).toMatchObject({
      title: 'Order',
      links: [{ active: true }],
    });
    expect(result.links[0].href).toContain('?page=2');
  });
  it('accepts quoted MIME parameters without matching text inside other quoted parameters', () => {
    const result = parseCatalog(
      feed(
        entry(
          '<link type="Application/Atom+XML; profile=&quot;opds-catalog&quot;; TYPE=&quot;entry&quot;" rel="alternate" href="book/1"/>',
        ),
      ),
      root,
    );
    expect(result.publications).toHaveLength(1);
    const navigation = parseCatalog(
      feed(
        entry(
          '<link type="application/atom+xml; title=&quot;;type=entry&quot;;type=feed" rel="alternate" href="series"/>',
        ),
      ),
      root,
    );
    expect(navigation.publications).toHaveLength(0);
    expect(navigation.navigation).toHaveLength(1);
  });
  it('keeps borrow, buy and indirect acquisitions as publications instead of dropping them', () => {
    const result = parseCatalog(
      feed(
        entry(
          '<link type="application/pdf" rel="http://opds-spec.org/acquisition/borrow" href="borrow/1"/>',
        ) +
          entry(
            '<link type="text/html" rel="http://opds-spec.org/acquisition/buy" href="buy/1"><opds:indirectAcquisition type="application/zip"/></link>',
          ),
      ),
      root,
    );
    expect(result.publications).toHaveLength(2);
    expect(result.publications[1].links[0].indirect).toBe(true);
  });
  it('recognizes PSE-only acquisitions without a server-specific reading restriction', () => {
    const pub = parseCatalog(
      feed(
        entry(
          '<link xmlns:pse="http://vaemendis.net/opds-pse/ns" rel="http://vaemendis.net/opds-pse/stream" type="image/jpeg" href="pages/{pageNumber}" pse:count="4" pse:lastRead="2"/>',
        ),
      ),
      root,
    ).publications[0];
    expect(pub.links[0]).toMatchObject({ count: 4, lastRead: 2 });
    expect(safePse(pub.links[0])).toBe(true);
    expect(
      safePse({
        ...pub.links[0],
        href: 'https://catalog.example/api/opds/secret/image?chapterId=2&pageNumber={pageNumber}&saveProgress=false',
      }),
    ).toBe(true);
  });
  it.each([
    '/api/opds/example-key/image',
    '/kavita/API/OpDs/example-key/IMAGE',
    '/base/%61pi/o%70ds/example-key/%69mage',
    '/api/opds/key%20with%2Fslash/image',
    '/api/opds/%E6%B5%8B%E8%AF%95/image/',
  ])('accepts canonical and encoded image routes as ordinary PSE templates: %s', (path) => {
    const publication = jsonPublication(
      {
        metadata: { title: 'Pages' },
        links: [
          {
            href: `${path}?pageNumber={pageNumber}&saveProgress=false`,
            rel: 'http://vaemendis.net/opds-pse/stream',
            type: 'image/jpeg',
          },
        ],
      },
      root,
    );
    const link = { ...publication.links[0], count: 4 };
    expect(safePse(link)).toBe(true);
    expect(publicationAccess({ ...publication, links: [link] })).toMatchObject({
      readable: true,
      template: link,
    });
  });
  it.each([
    '/opds/books/bad%/pages/{pageNumber}',
    '/opds/books/bad%GG/pages/{pageNumber}',
    '/opds/books/bad%E0%A4/pages/{pageNumber}',
  ])('rejects malformed PSE path encoding without requesting or guessing its route: %s', (path) => {
    const publication = jsonPublication(
      {
        metadata: { title: 'Pages' },
        links: [
          {
            href: path,
            rel: 'http://vaemendis.net/opds-pse/stream',
            type: 'image/jpeg',
          },
        ],
      },
      root,
    );
    const link = { ...publication.links[0], count: 4 };
    expect(safePse(link)).toBe(false);
    expect(publicationAccess({ ...publication, links: [link] }).unavailableReason).toBe(
      '此条目的图片清单或页流格式暂不支持。',
    );
  });
  it.each([
    '/opds/v1.2/books/book%20name/pages/{pageNumber}',
    '/reader/opds/v1.2/books/%E6%B5%8B%E8%AF%95/pages/{pageNumber}',
    '/api%2Fopds/example-key/image?pageNumber={pageNumber}',
    '/api/opds/example-key/%2569mage?pageNumber={pageNumber}',
  ])('keeps ordinary and encoded image templates: %s', (path) => {
    const publication = jsonPublication(
      {
        metadata: { title: 'Pages' },
        links: [
          {
            href: path,
            rel: 'http://vaemendis.net/opds-pse/stream',
            type: 'image/jpeg',
          },
        ],
      },
      root,
    );
    expect(safePse({ ...publication.links[0], count: 4 })).toBe(true);
  });
  it.each([
    'pages/{pageNumber}/{unsupported}',
    'pages/{pageNumber}?width={maxWidth',
    'pages/{pageNumber}?extra=%7Bunsupported%7D',
    'pages/0?width={maxWidth}',
  ])('rejects missing page variables and unsupported or malformed templates: %s', (href) => {
    const publication = jsonPublication(
      {
        metadata: { title: 'Pages' },
        links: [
          {
            href,
            rel: 'http://vaemendis.net/opds-pse/stream',
            type: 'image/jpeg',
          },
        ],
      },
      root,
    );
    expect(safePse({ ...publication.links[0], count: 4 })).toBe(false);
  });
  it.each([undefined, 0, -1, 1.5, 20001, Number.POSITIVE_INFINITY])(
    'rejects missing or unbounded PSE page counts: %s',
    (count) => {
      const publication = jsonPublication(
        {
          metadata: { title: 'Pages' },
          links: [
            {
              href: 'pages/{pageNumber}?width={maxWidth}&height={maxHeight}',
              rel: 'http://vaemendis.net/opds-pse/stream',
              type: 'image/jpeg',
            },
          ],
        },
        root,
      );
      expect(safePse({ ...publication.links[0], count })).toBe(false);
      expect(safePse({ ...publication.links[0], count: 4 })).toBe(true);
      expect(safePse({ ...publication.links[0], count: 4, encrypted: true })).toBe(false);
      expect(safePse({ ...publication.links[0], count: 4, indirect: true })).toBe(false);
    },
  );
  it('does not fetch DTD/entities or accept mismatched XML', () => {
    expect(() =>
      parseCatalog(
        '<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///secret">]>' + feed('<title>&x;</title>'),
        root,
      ),
    ).toThrow();
    expect(() =>
      parseCatalog('<feed xmlns="http://www.w3.org/2005/Atom"><title>x</feed>', root),
    ).toThrow();
  });
  it('preserves OPDS2 mixed groups/facets and never uses ISBN as record identity', () => {
    const pub = {
      metadata: {
        title: 'Issue',
        identifier: 'urn:isbn:123',
        author: [{ name: 'Author' }],
      },
      links: [
        {
          rel: 'self',
          href: 'books/1',
          type: 'application/opds-publication+json',
        },
        {
          rel: 'download',
          href: '1.cbz',
          type: 'application/vnd.comicbook+zip',
        },
      ],
      images: [{ href: 'cover.jpg', type: 'image/jpeg' }],
    };
    const result = parseCatalog(
      JSON.stringify({
        metadata: { title: 'Mixed' },
        links: [{ rel: 'self', href: root }],
        navigation: [{ title: 'All', href: 'all' }],
        publications: [pub],
        groups: [
          {
            metadata: { title: 'Featured' },
            links: [{ rel: 'self', href: 'featured' }],
            publications: [pub],
          },
        ],
        facets: [
          {
            metadata: { title: 'Sort' },
            links: [{ rel: 'self', title: 'Title', href: '?sort=title' }],
          },
        ],
      }),
      root,
    );
    expect(result.publications[0].identity).toBe('https://catalog.example/opds/books/1');
    expect(result.publications[0].authors).toEqual(['Author']);
    expect(result.groups[0].publications).toHaveLength(1);
    expect(result.facets[0].links[0].rels).toEqual(['self']);
    expect(result.publications[0].readingOrder).toBeUndefined();
  });
  it('does not confuse cover images, EPUB XHTML, encrypted resources and an image manifest', () => {
    const p = jsonPublication(
      {
        metadata: { title: 'Image' },
        images: [{ href: 'cover.jpg', type: 'image/jpeg' }],
        readingOrder: [
          { href: 'page.png', type: 'image/png' },
          { href: 'chapter.xhtml', type: 'application/xhtml+xml' },
          {
            href: 'secret.jpg',
            type: 'image/jpeg',
            properties: { encrypted: { scheme: 'x' } },
          },
        ],
      },
      root,
    );
    expect(p.readingOrder!.map(isBitmap)).toEqual([true, false, false]);
    expect(() =>
      parsePublication(
        JSON.stringify({
          metadata: { title: 'Broken' },
          readingOrder: [{ type: 'image/jpeg' }],
        }),
        root,
      ),
    ).toThrow();
  });
  it('recognizes direct EPUB acquisition without treating XHTML as image pages', () => {
    const publication = jsonPublication(
      {
        metadata: { title: 'EPUB' },
        links: [
          {
            rel: 'http://opds-spec.org/acquisition',
            type: 'application/epub+zip',
            href: 'book.epub',
          },
        ],
        readingOrder: [{ href: 'chapter.xhtml', type: 'application/xhtml+xml' }],
      },
      root,
    );
    const access = publicationAccess(publication);
    expect(access.readable).toBe(true);
    expect(access.pages).toBeUndefined();
    expect(access.files.map((file) => file.format)).toEqual(['epub']);
    expect(
      publicationAccess({
        ...publication,
        readingOrder: [
          {
            ...publication.links[0],
            href: root + '/page.jpg',
            type: 'image/jpeg',
          },
        ],
      }).pages,
    ).toHaveLength(1);
    expect(
      publicationAccess({
        ...publication,
        links: [{ ...publication.links[0], encrypted: true }],
      }).files,
    ).toHaveLength(0);
  });
  it('expands advertised OpenSearch/OPDS2 query templates without inventing pagination', () => {
    const template = parseSearchDescription(
      '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><Url type="application/atom+xml" template="search?q={searchTerms}&amp;page={startPage?}"/></OpenSearchDescription>',
      root,
    );
    expect(expandSearch(template, '猫 & dog')).toBe(
      'https://catalog.example/opds/search?q=%E7%8C%AB%20%26%20dog&page=',
    );
    expect(expandSearch('https://catalog.example/search{?query}', 'a+b')).toBe(
      'https://catalog.example/search?query=a%2Bb',
    );
    expect(() => expandSearch('https://catalog.example/{unsupported}', 'q')).toThrow();
  });
  it('shows an unsupported auth flow instead of parsing an authentication document as a catalog', () => {
    expect(() =>
      parseCatalog(
        JSON.stringify({
          id: 'auth',
          authentication: [{ type: 'http://opds-spec.org/auth/oauth/implicit' }],
        }),
        root,
      ),
    ).toThrowError(/登录流程/);
  });
  it('removes only known URL-token credential positions for identity', () => {
    const connection: PrivateConnection = {
      id: 'conn',
      name: 'Private',
      root: 'https://catalog.example/api/opds/old-key',
      auth: { kind: 'url-token' },
      revision: 1,
      namespace: 'opds1',
      createdAt: 1,
    };
    expect(identityUrl('https://catalog.example/api/opds/new-key/book?id=17', connection)).toBe(
      identityUrl('https://catalog.example/api/opds/old-key/book?id=17', connection),
    );
    expect(identityUrl('https://catalog.example/api/opds/new-key/book?id=18', connection)).not.toBe(
      identityUrl('https://catalog.example/api/opds/old-key/book?id=17', connection),
    );
    expect(identityUrl('https://catalog.example/different/opaque-key/book', connection)).toContain(
      'opaque-key',
    );
  });
});
