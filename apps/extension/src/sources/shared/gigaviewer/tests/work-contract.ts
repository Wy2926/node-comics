import {describe, expect, it, vi} from 'vitest';
import type {SourceDefinition} from '../../../contracts/definition';
import {pageFactories} from '../../../registry/pages';
import type {GigaViewerSerialProtocol} from '../serial-protocol';

export function verifySerialWork(definition: SourceDefinition, protocol: GigaViewerSerialProtocol) {
  const work = protocol.catalogUrl('7'), chapter = protocol.episodeUrl('11');
  function fixture(url = chapter) {
    const data = {readableProduct: {id: '11', typeName: 'episode', permalink: chapter,
      title: 'Chapter 11 — never use this', series: {id: '7', title: '  Work\n &\tName  '}, pageStructure: null}};
    let raw: string | undefined;
    const nodes: Record<string, Array<{getAttribute: (name: string) => string | null}>> = {
      'link[rel="canonical"]': [{getAttribute: () => chapter}],
      '#episode-json': [{getAttribute: () => raw ?? JSON.stringify(data)}],
    };
    const querySelectorAll = vi.fn((selector: string) => nodes[selector]);
    const controller = new AbortController(), context = {document: {title: 'Chapter title', querySelectorAll} as unknown as Document,
      location: definition.identify(new URL(url))!, signal: controller.signal};
    const session = pageFactories[definition.id](context);
    return {data, nodes, querySelectorAll, controller, context, session, setRaw: (value: string) => {raw = value;}, read: () => session.describeWork!()};
  }
  describe(`${definition.id} current-document work name`, () => {
    it.each([work, chapter, protocol.episodeUrl('11', '7')])('reads only series metadata at %s, even without readable pages', url => {
      const f = fixture(url);
      expect(f.read()).toEqual({status: 'ready', value: {title: 'Work & Name', catalogId: protocol.seriesKey('7'), catalogUrl: work}});
      expect(f.querySelectorAll.mock.calls).toEqual([['link[rel="canonical"]'], ['#episode-json']]);
      f.session.dispose();
    });
    it('re-reads changed metadata and rejects stale chapters, series bindings and foreign source identities', () => {
      const f = fixture();
      expect(f.read().status).toBe('ready');
      f.data.readableProduct.series.title = 'Updated work';
      expect(f.read()).toMatchObject({status: 'ready', value: {title: 'Updated work'}});
      f.data.readableProduct.id = '12'; expect(f.read().status).toBe('not-ready');
      for (const url of [protocol.catalogUrl('8'), protocol.episodeUrl('11', '8'), protocol.episodeUrl('12')]) {
        const stale = fixture(url); expect(stale.read().status).toBe('not-ready'); stale.session.dispose();
      }
      f.data.readableProduct.id = '11'; f.context.location.sourceId = 'foreign';
      expect(f.read().status).toBe('not-ready'); f.session.dispose();
    });
    it.each(['missing-canonical', 'duplicate-canonical', 'foreign-canonical', 'stale-canonical', 'missing-data', 'duplicate-data',
      'foreign-product', 'wrong-type', 'invalid-series', 'invalid-json', 'oversize-data'])(
      'rejects %s without guessing from chapter headings or document titles', mode => {
        const f = fixture();
        if (mode === 'missing-canonical') f.nodes['link[rel="canonical"]'] = [];
        if (mode === 'duplicate-canonical') f.nodes['link[rel="canonical"]'].push(f.nodes['link[rel="canonical"]'][0]);
        if (mode === 'foreign-canonical') f.nodes['link[rel="canonical"]'][0] = {getAttribute: () => 'https://foreign.test/episode/11'};
        if (mode === 'stale-canonical') f.nodes['link[rel="canonical"]'][0] = {getAttribute: () => protocol.episodeUrl('12')};
        if (mode === 'missing-data') f.nodes['#episode-json'] = [];
        if (mode === 'duplicate-data') f.nodes['#episode-json'].push(f.nodes['#episode-json'][0]);
        if (mode === 'foreign-product') f.data.readableProduct.permalink = 'https://foreign.test/episode/11';
        if (mode === 'wrong-type') f.data.readableProduct.typeName = 'volume';
        if (mode === 'invalid-series') f.data.readableProduct.series.id = 'bad';
        if (mode === 'invalid-json') f.setRaw('{bad');
        if (mode === 'oversize-data') f.setRaw(' '.repeat(4_000_001));
        expect(f.read().status).toBe('not-ready'); f.session.dispose();
      });
    it.each(['', ' ', '\u0000invalid', 'x'.repeat(2001)])('leaves invalid work names empty', title => {
      const f = fixture(); f.data.readableProduct.series.title = title;
      expect(f.read().status).toBe('not-ready'); f.session.dispose();
    });
    it('rejects reads after disposal or cancellation', () => {
      const f = fixture(); f.session.dispose(); expect(f.read).toThrow('SOURCE_SESSION_EXPIRED');
      const cancelled = fixture(); cancelled.controller.abort(Error('navigation'));
      expect(cancelled.read).toThrow('navigation'); cancelled.session.dispose();
    });
  });
}
