import 'fake-indexeddb/auto';
import {createCipheriv} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {network} from '../network';
import {validateSourceCatalog} from '../../..';
import {readSourceCatalog} from '../../../runtime/catalog-reader';
import {catalog} from '../../../../comics/repositories';
import {importCatalog} from '../../../../comics/application/import-service';
import {syncNextCatalog} from '../../../../comics/application/catalog-sync';

const slug = 'http-fixture', url = 'https://www.mangacopy.com/comic/' + slug;
const secret = 'fixture-key-1234', iv = 'fixture-iv-12345';
const uuid = (n: number) => `724f819b-5306-11ea-b7ea-${String(n).padStart(12, '0')}`;
const html = `<div class="comicParticulars-title-left"><img data-src="https://sg.mangafunb.fun/cover.jpg?x=1&amp;y=2"></div>
  <div class="comicParticulars-title-right"><h6>Test &amp; &#28459;&#30011;</h6></div><div class="upLoop">loading</div>
  <script>var ccz = '${secret}'; globalThis.mustNotExecute = true;</script>`;
function payload(ids = [1, 2]) {
  return {build: {path_word: slug, type: [{id: 1, name: '話'}, {id: 9, name: '源站新标签'}]}, groups: {
    default: {path_word: 'default', name: '默認', count: ids.length,
      chapters: ids.map(n => ({id: uuid(n), name: '第' + n + '話', type: 1})),
      last_chapter: {uuid: uuid(ids.at(-1)!), count: ids.length, comic_path_word: slug, group_path_word: 'default'}},
  }};
}
function encrypted(data: unknown, key = secret) {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return JSON.stringify({code: 200, results: iv + Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('hex')});
}
const requestFor = (data: unknown = payload(), page = html) => vi.fn(async (target: string) => target.includes('/comicdetail/') ? encrypted(data) : page);
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const comic of await catalog.list('comics', {limit: 10000})) await catalog.deleteComic(comic.id);
});

describe('MangaCopy HTTP directory', () => {
  it.each(['www.mangacopy.com', 'www.copy4000.com'])('reads %s with two HTTP requests and preserves source IDs', async host => {
    const target = url.replace('www.mangacopy.com', host), request = requestFor();
    const source = validateSourceCatalog(await network.catalog!(target, {request}));
    expect(request.mock.calls.map(call => call[0])).toEqual([target, `https://${host}/comicdetail/${slug}/chapters`]);
    expect(source).toMatchObject({id: 'mangacopy:' + slug, title: 'Test & 漫画', complete: true,
      cover: {url: 'https://sg.mangafunb.fun/cover.jpg?x=1&y=2'}, defaultEntryId: `mangacopy:${slug}:${uuid(1)}`});
    expect(source.entries.map(entry => entry.remoteId)).toEqual([uuid(1), uuid(2)]);
    expect(source.entries[0]).toMatchObject({id: `mangacopy:${slug}:${uuid(1)}`, sequenceId: 'default:話',
      url: target + '/chapter/' + uuid(1), rawTypes: ['話'], related: false});
    expect((globalThis as Record<string, unknown>).mustNotExecute).toBeUndefined();
  });
  it('keeps arbitrary groups and source type labels, merging cross-group references only', async () => {
    const data = payload(), first = data.groups.default;
    Object.assign(data.groups, {new_series: {...first, path_word: 'new_series', name: '其他系列', count: 2,
      chapters: [first.chapters[0], {id: uuid(3), name: '特别企划', type: 9}],
      last_chapter: {...first.last_chapter, uuid: uuid(3), group_path_word: 'new_series'}}});
    const source = validateSourceCatalog(await network.catalog!(url, {request: requestFor(data)}));
    expect(source.groups.map(group => group.id)).toEqual(['default', 'new_series']);
    expect(source.entries).toHaveLength(3);
    expect(source.entries[0]).toMatchObject({groupIds: ['default', 'new_series'], sequenceId: undefined});
    expect(source.entries[2]).toMatchObject({rawTypes: ['源站新标签'], sequenceId: 'new_series:源站新标签', related: false});
    const noDefault = {...data, groups: {new_series: {...first, path_word: 'new_series', last_chapter: {...first.last_chapter, group_path_word: 'new_series'}}}};
    expect((await network.catalog!(url, {request: requestFor(noDefault)})).defaultEntryId).toBeUndefined();
  });
  it.each(['missing', 'duplicate', 'foreign', 'bad-id', 'unknown-type', 'last-owner', 'last-group', 'last-id', 'last-count', 'group-id', 'duplicate-type', 'empty'])('rejects %s directory data atomically', async mode => {
    const data = payload(), group = data.groups.default;
    if (mode === 'missing') group.count++;
    if (mode === 'duplicate') group.chapters[1] = group.chapters[0];
    if (mode === 'foreign') data.build.path_word = 'other';
    if (mode === 'bad-id') group.chapters[0].id = '../other';
    if (mode === 'unknown-type') group.chapters[0].type = 77;
    if (mode === 'last-owner') group.last_chapter.comic_path_word = 'other';
    if (mode === 'last-group') group.last_chapter.group_path_word = 'other';
    if (mode === 'last-id') group.last_chapter.uuid = uuid(99);
    if (mode === 'last-count') group.last_chapter.count++;
    if (mode === 'group-id') group.path_word = 'other';
    if (mode === 'duplicate-type') data.build.type.push(data.build.type[0]);
    if (mode === 'empty') {group.chapters = []; group.count = 0;}
    await expect(network.catalog!(url, {request: requestFor(data)})).rejects.toThrow('目录未完整加载');
  });
  it('rejects missing/ambiguous keys, invalid ciphertext, error responses and malformed JSON', async () => {
    for (const page of [html.replace('var ccz', 'var other'), html + `<script>var ccz='${secret}';</script>`, '<h6>challenge</h6>']) {
      const request = requestFor(payload(), page);
      await expect(network.catalog!(url, {request})).rejects.toThrow(); expect(request).toHaveBeenCalledOnce();
    }
    for (const response of ['{}', '<html>error</html>', '{"code":403}', '{"code":200,"results":"invalid"}', encrypted(payload(), 'another-key-1234')])
      await expect(network.catalog!(url, {request: async target => target.includes('/comicdetail/') ? response : html})).rejects.toThrow();
  });
  it('rejects cancellation and unsupported URLs before further requests', async () => {
    const controller = new AbortController(), request = requestFor(); controller.abort();
    await expect(network.catalog!(url, {request, signal: controller.signal})).rejects.toThrow();
    for (const target of [url.replace('mangacopy.com', 'mangacopy.com.evil.test'), url + '/chapter/' + uuid(1)])
      await expect(network.catalog!(target, {request})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    const second = new AbortController(), interrupted = vi.fn(async () => {second.abort(); return html;});
    await expect(network.catalog!(url, {request: interrupted, signal: second.signal})).rejects.toThrow();
    expect(interrupted).toHaveBeenCalledOnce();
  });
  it('uses the common HTTP route in worker contexts and never falls back to a source tab', async () => {
    const create = vi.fn(() => {throw Error('unexpected tab');}), request = requestFor();
    vi.stubGlobal('chrome', {tabs: {create}});
    vi.stubGlobal('fetch', vi.fn(async (target: string) => new Response(await request(String(target)))));
    expect((await readSourceCatalog(url)).entries).toHaveLength(2);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', {status: 503})));
    await expect(readSourceCatalog(url)).rejects.toThrow('503'); expect(create).not.toHaveBeenCalled();
  });
  it('detects additions once and retains the old directory and schedule after a failed HTTP check', async () => {
    const first = await network.catalog!(url, {request: requestFor(payload([1]))}), comic = await importCatalog(first);
    const due = async () => {const current = (await catalog.get('comics', comic.id))!; await catalog.put('comics', {...current, catalogSync: {...current.catalogSync, nextCheckAt: 0}});};
    const read = () => network.catalog!(url, {request: requestFor()});
    await due(); await syncNextCatalog(read); await due(); await syncNextCatalog(read);
    expect((await catalog.get('comics', comic.id))?.catalogUpdates?.count).toBe(1);
    const previous = await catalog.get('catalogs', first.id), broken = payload([1, 2, 3]); broken.groups.default.count++;
    await due(); await syncNextCatalog(() => network.catalog!(url, {request: requestFor(broken)}));
    expect(await catalog.get('catalogs', first.id)).toEqual(previous);
    expect((await catalog.get('comics', comic.id))?.catalogSync?.nextCheckAt).toBeGreaterThan(Date.now() + 719 * 60_000);
  });
});
