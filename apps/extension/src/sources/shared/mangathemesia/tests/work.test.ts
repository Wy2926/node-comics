import {describe, expect, it, vi} from 'vitest';
import {mangaThemesiaWork} from '../work';
import {fixtureDefinition, sites, work, chapter, workDocument as documentFixture, workElement as element} from './fixtures';
const contextFor = (site: typeof sites[number], document: Document, url: string) => ({
  document, location: fixtureDefinition(site).identify(new URL(url))!, signal: new AbortController().signal,
});

describe('MangaThemesia current-page work metadata', () => {
  it.each(sites)('reads $id catalog title without requiring or fetching its chapter list', site => {
    const read = mangaThemesiaWork(site), url = site.catalogUrl(work), fixture = documentFixture(url);
    const select = vi.spyOn(fixture.document, 'querySelectorAll');
    expect(read(contextFor(site, fixture.document, url))).toEqual({status: 'ready', value: {
      title: 'Sample & Book', catalogId: site.catalogKey(work), catalogUrl: url,
    }});
    expect(select).toHaveBeenCalledTimes(2);
  });

  it.each(sites)('reads $id owner-link title on bare and bound chapters even with unrelated names', site => {
    const read = mangaThemesiaWork(site), url = site.chapterUrl(chapter), fixture = documentFixture(url, 'A Different Work', site.catalogUrl(work));
    for (const current of [url, site.chapterUrl(chapter, work)]) {
      expect(read(contextFor(site, fixture.document, current))).toEqual({status: 'ready', value: {
        title: 'A Different Work', catalogId: site.catalogKey(work), catalogUrl: site.catalogUrl(work),
      }});
    }
    expect(read(contextFor(site, fixture.document, site.chapterUrl(chapter, 'other'))).status).toBe('not-ready');
  });

  it('normalizes DOM whitespace and re-reads the current title instead of caching it', () => {
    const site = sites[0], url = site.catalogUrl(work), fixture = documentFixture(url, '  Sample\n &\tBook  ');
    const read = mangaThemesiaWork(site), context = contextFor(site, fixture.document, url);
    expect(read(context)).toMatchObject({status: 'ready', value: {title: 'Sample & Book'}});
    fixture.nodes['.postbody h1.entry-title'][0].textContent = 'Updated work';
    expect(read(context)).toMatchObject({status: 'ready', value: {title: 'Updated work'}});
  });

  it.each(['missing-canonical', 'duplicate-canonical', 'foreign-canonical', 'other-chapter', 'missing-owner', 'duplicate-owner',
    'foreign-owner', 'chapter-owner', 'empty-title', 'oversize-title', 'control-title'] as const)('rejects %s without using a chapter or document title', kind => {
    const [site, foreign] = sites, url = site.chapterUrl(chapter), fixture = documentFixture(url, 'Sample & Book', site.catalogUrl(work));
    const canonical = fixture.nodes['link[rel="canonical"]'], owner = fixture.nodes['.chapterbody .allc a[href]'];
    if (kind === 'missing-canonical') canonical.length = 0;
    if (kind === 'duplicate-canonical') canonical.push(canonical[0]);
    if (kind === 'foreign-canonical') canonical[0] = element('', foreign.chapterUrl(chapter));
    if (kind === 'other-chapter') canonical[0] = element('', site.chapterUrl('other-chapter-1'));
    if (kind === 'missing-owner') owner.length = 0;
    if (kind === 'duplicate-owner') owner.push(owner[0]);
    if (kind === 'foreign-owner') owner[0] = element('Sample & Book', foreign.catalogUrl(work));
    if (kind === 'chapter-owner') owner[0] = element('Chapter 99', site.chapterUrl('other-chapter-1'));
    if (kind === 'empty-title') owner[0].textContent = '  ';
    if (kind === 'oversize-title') owner[0].textContent = 'x'.repeat(2049);
    if (kind === 'control-title') owner[0].textContent = 'Sample\u0000Book';
    expect(mangaThemesiaWork(site)(contextFor(site, fixture.document, url)).status).toBe('not-ready');
  });

  it('rejects changed catalog identity, duplicate headings, foreign contexts and cancelled reads', () => {
    const site = sites[0], url = site.catalogUrl(work), fixture = documentFixture(url), read = mangaThemesiaWork(site);
    const context = contextFor(site, fixture.document, url);
    fixture.nodes['link[rel="canonical"]'] = [element('', site.catalogUrl('other'))];
    expect(read(context).status).toBe('not-ready');
    fixture.nodes['link[rel="canonical"]'] = [element('', url)];
    fixture.nodes['.postbody h1.entry-title'].push(element('Conflicting title'));
    expect(read(context).status).toBe('not-ready');
    fixture.nodes['.postbody h1.entry-title'].pop();
    expect(read({...context, location: {...context.location, sourceId: 'foreign'}}).status).toBe('not-ready');
    const abort = new AbortController(); abort.abort(Error('navigation'));
    expect(() => read({...context, signal: abort.signal})).toThrow('navigation');
  });
});
