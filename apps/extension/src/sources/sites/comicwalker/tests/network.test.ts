import {describe, expect, it, vi} from 'vitest';
import {definitions} from '../../../registry/definitions';
import {sourceNetworks} from '../../../registry/networks';
import {validateSourceCatalog} from '../../../index';
import {catalogUrl, definition, episodeUrl, origin} from '../definition';
import {network, parseCatalog, parsePages} from '../network';
import {image} from '../image';
import {episode, episodeId, fixture, html, manuscripts, work, cover} from './fixtures';

const url = episodeUrl(work, episode), catalog = catalogUrl(work);
describe('ComicWalker source', () => {
  it('registers pure URL identity, search, import and explicit content matches', () => {
    expect(definitions).toContain(definition); expect(sourceNetworks.comicwalker).toBe(network);
    expect(definition.identify(new URL(url))).toMatchObject({kind: 'reader', catalog: {url: catalog}});
    expect(definition.identify(new URL(catalog))).toMatchObject({kind: 'catalog'});
    expect(definition.identify(new URL(origin + '/viewer/' + episode))).toMatchObject({kind: 'reader'});
    for (const host of ['http://comic-walker.com', 'https://comic-walker.com.evil.test', 'https://user@comic-walker.com', 'https://comic-walker.com:444'])
      expect(definition.identify(new URL(host + '/detail/' + work))).toBeNull();
    for (const path of ['/', '/search', '/detail/bad', '/viewer/bad'])
      expect(definition.identify(new URL(origin + path))?.kind).toBe('other');
    expect(definition.installation.optionalContentMatches).toEqual([origin + '/*']);
  });
  it('preserves source order, dedicated artwork, expired entries and separate volume sequences', () => {
    const data = fixture(), details = data.props.pageProps.dehydratedState.queries[0].state.data;
    Object.assign(details, {comics: {total: 1, result: [{id: episodeId, title: 'Volume 1', episodes: [
      {code: 'KC_0000010000100012_E', title: 'Trial', subTitle: '', type: 'normal', serviceId: 'web_trial', isActive: true}]}]}});
    const result = validateSourceCatalog(parseCatalog(html(data), catalog));
    expect(result).toMatchObject({complete: true, title: 'Fixture Work', cover: {url: cover}});
    expect(result.entries.map(e => e.readable)).toEqual([true, false, true]);
    expect(result.entries[2].sequenceId).not.toBe(result.entries[0].sequenceId);
    expect(result.entries[2].url).toContain('episodeType=comics');
  });
  it.each(['owner', 'duplicate', 'partial', 'query', 'cover'])('rejects %s catalog corruption', kind => {
    const data = fixture(), props = data.props.pageProps, details = props.dehydratedState.queries[0].state.data;
    if (kind === 'owner') props.workCode = 'KC_000002_S';
    if (kind === 'query') props.dehydratedState.queries[0].queryKey[0] = '/other';
    // JSON fixtures deliberately vary their schemas to test the untrusted boundary.
    const bad = JSON.parse(JSON.stringify(details));
    if (kind === 'duplicate') bad.firstEpisodes.result[1] = bad.firstEpisodes.result[0];
    if (kind === 'partial') bad.firstEpisodes.total++;
    if (kind === 'cover') bad.work.originalThumbnail = 'https://evil.test/cover.webp';
    props.dehydratedState.queries[0].state.data = bad;
    expect(() => parseCatalog(html(data), catalog)).toThrow();
  });
  it('resolves bare viewer links; makes only metadata requests and respects cancellation', async () => {
    const request = vi.fn(async () => html());
    expect(await network.resolveCatalog!(origin + '/viewer/' + episode, {request})).toBe(catalog);
    expect(request).toHaveBeenCalledExactlyOnceWith(catalog, undefined);
    await expect(network.resolveCatalog!(origin + '/viewer/KC_0000019999900011_E', {request})).rejects.toThrow();
    const previous = parseCatalog(html(), catalog), saved = JSON.stringify(previous);
    await expect(network.catalog!(catalog, {request: async () => '<html>Verification</html>', previous})).rejects.toThrow();
    expect(JSON.stringify(previous)).toBe(saved);
    const controller = new AbortController(); request.mockImplementationOnce(async () => {controller.abort(); return html();});
    await expect(network.catalog!(catalog, {request, signal: controller.signal})).rejects.toThrow();
    request.mockClear(); await expect(network.catalog!(catalog, {request, signal: controller.signal})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('reads a complete ordered manifest with stable content keys despite renewed signatures', async () => {
    const request = vi.fn(async (target: string) => target.includes('/api/') ? JSON.stringify(manuscripts()) : html());
    const result = await network.pages!(url, {request});
    expect(request).toHaveBeenCalledTimes(2); expect(result).toMatchObject({knownTotal: 8, discoveryComplete: true});
    const renewed = manuscripts(); renewed.manuscripts.reverse(); renewed.manuscripts.forEach(p => p.drmImageUrl += '&renewed=1');
    const next = parsePages(renewed, url, 'Chapter', 8);
    expect(next.items.map(p => p.contentKey)).toEqual(result.items.map(p => p.contentKey));
    const repeated = manuscripts(); repeated.manuscripts[1].drmImageUrl = repeated.manuscripts[0].drmImageUrl;
    expect(new Set(parsePages(repeated, url, 'Chapter', 8).items.map(p => p.id)).size).toBe(8);
  });
  it.each(['missing', 'duplicate', 'mode', 'hash', 'host', 'owner', 'dimensions'])('rejects %s page metadata', kind => {
    const data = manuscripts(), first = data.manuscripts[0];
    if (kind === 'missing') data.manuscripts.pop();
    if (kind === 'duplicate') first.page = 2;
    if (kind === 'mode') first.drmMode = 'unknown';
    if (kind === 'hash') first.drmHash = 'bad';
    if (kind === 'host') first.drmImageUrl = first.drmImageUrl.replace('cdn.comic-walker.com', 'evil.test');
    if (kind === 'owner') first.drmImageUrl = first.drmImageUrl.replace('/images/1/', '/images/2/');
    if (kind === 'dimensions') first.width = 0;
    expect(() => parsePages(data, url, 'Chapter', 8)).toThrow();
  });
  it('refuses expired chapters before requesting manuscripts', async () => {
    const data = fixture(); Object.assign(data.props.pageProps.dehydratedState.queries[1].state.data, {episode: {code: episode, isActive: false}});
    const request = vi.fn(async () => html(data));
    await expect(network.pages!(url, {request})).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
  });
  it('decodes exact XOR bytes, rejects invalid output/recipes and obeys abort', async () => {
    const plain = new TextEncoder().encode('RIFF1234WEBPsynthetic-byte-fixture');
    const key = Uint8Array.from([1, 35, 69, 103, 137, 171, 205, 239]);
    const encoded = plain.map((byte, i) => byte ^ key[i % 8]), blob = new Blob([encoded]);
    const decoded = await image.decode!(blob, new Headers(), 'comicwalker-xor:0123456789abcdef');
    expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(plain); expect(decoded.type).toBe('image/webp');
    expect(await image.decode!(blob, new Headers(), undefined)).toBe(blob);
    await expect(image.decode!(blob, new Headers(), 'wrong')).rejects.toThrow();
    await expect(image.decode!(new Blob(['bad']), new Headers(), 'comicwalker-xor:0123456789abcdef')).rejects.toThrow();
    await expect(image.decode!(blob, new Headers(), 'comicwalker-xor:0123456789abcdef', AbortSignal.abort())).rejects.toThrow();
  });
  it('searches lightweight candidates and bounds pagination without reading directories', async () => {
    const row = {code: work, title: 'Work', originalThumbnail: cover, language: 'ja', authors: [{name: 'Artist'}]};
    const request = vi.fn(async (_target: string) => JSON.stringify({pagination: {total: 1}, result: [row]}));
    expect(await network.search!({siteId: 'comicwalker', query: 'Work'}, {request})).toMatchObject({items: [{catalogUrl: catalog, contentLanguages: ['ja'], authors: ['Artist']} ]});
    expect(request.mock.calls[0][0]).toContain('/api/search/keywords?');
    for (const cursor of ['-1', '1', '32.0', 'https://evil.test', '100000'])
      await expect(network.search!({siteId: 'comicwalker', query: 'Work', cursor}, {request})).rejects.toThrow();
  });
});
