import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {RandomAccessSource} from '../src/comics/formats/contracts';
import type {FileSourceDriver, OpenFileSourceContext} from '../src/comics/sources/contracts';
import {getSourceDriver, registerSourceDriver, requireSourceDriver} from '../src/comics/sources/registry';
import {closeSourceAccess, openFileSource} from '../src/comics/sources/runtime';
import {SourceDatabaseSchemaError} from '../src/storage/database';

const cache = vi.hoisted(() => ({get: vi.fn(), token: vi.fn(), put: vi.fn()}));
vi.mock('../src/storage/source-ranges', async importOriginal => ({
  ...await importOriginal<typeof import('../src/storage/source-ranges')>(), sourceRangeCache: cache,
}));

const saved = new Map<string, Blob>();
const unregister: (() => void)[] = [];
const opened: RandomAccessSource[] = [];
beforeEach(() => {
  saved.clear();
  cache.get.mockReset().mockImplementation(async (key: string) => saved.get(key));
  cache.token.mockReset().mockResolvedValue({generation: 1});
  cache.put.mockReset().mockImplementation(async (key: string, blob: Blob) => { saved.set(key, blob); });
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map(source => source.close()));
  for (const remove of unregister.splice(0)) remove();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}
function context(provider = 'fixture-files', connectionId = `${provider}:reader`, itemId = 'same-file', version = 'v1', marker = 7): OpenFileSourceContext {
  return {
    connection: {id: connectionId, provider, displayName: 'Fixture files', status: 'connected', generation: 1, createdAt: 1, updatedAt: 1},
    source:{connectionId,providerItemId:itemId,locator:{version:'untrusted-current-version'},generation:1,status:'active'},
    contentId:`content:${connectionId}:${itemId}:${version}`,sourceSnapshot:{version,marker},
    entryId: 'document', format: 'cbz',
  };
}
function fixtureDriver(options: {id?: string; local?: boolean; cacheRanges?: boolean} = {}) {
  const sources: (RandomAccessSource & {readAt: ReturnType<typeof vi.fn>; validate: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>})[] = [];
  const open = vi.fn(async (input: OpenFileSourceContext): Promise<RandomAccessSource> => {
    const source = {
      snapshot: {identity: `${input.connection.id}/${input.source.providerItemId}`, version: String(input.sourceSnapshot!.version), size: 32, local: !!options.local},
      readAt: vi.fn(async (_offset: number, length: number) => new Uint8Array(length).fill(Number(input.sourceSnapshot!.marker))),
      validate: vi.fn(async () => 'unchanged' as const), close: vi.fn(async () => {}),
    };
    sources.push(source); return source;
  });
  const driver: FileSourceDriver = {id: options.id ?? 'fixture-files', label: 'Fixture files', cachePages: true, cacheRanges: options.cacheRanges ?? true, open};
  unregister.push(registerSourceDriver(driver));
  return {driver, open, sources};
}
async function open(input = context()) {
  const source = await openFileSource(input); opened.push(source); return source;
}

describe('pluggable file-source runtime', () => {
  it('reads an arbitrary provider without Google and passes its frozen revision intact', async () => {
    const fixture = fixtureDriver(), input = context();
    Object.freeze(input.sourceSnapshot); Object.freeze(input.sourceSnapshot);
    expect(getSourceDriver('google-drive')).toBeUndefined();
    const source = await open(input);
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith(input);
    expect(fixture.open.mock.calls[0][0].sourceSnapshot).toBe(input.sourceSnapshot);
    expect([...await source.readAt(4, 3)]).toEqual([7, 7, 7]);
    expect(source.snapshot.version).toBe('v1');
    expect(await source.validate()).toBe('unchanged');
    await source.close(); await source.close();
    expect(fixture.sources[0].close).toHaveBeenCalledTimes(1);
  });

  it('rejects missing providers, duplicate registrations, and mismatched connections before opening', async () => {
    const fixture = fixtureDriver();
    await expect(openFileSource(context('not-installed'))).rejects.toThrow('此来源未启用');
    expect(() => requireSourceDriver('google-drive')).toThrow('此来源未启用');
    expect(() => registerSourceDriver({...fixture.driver})).toThrow('来源标识无效或重复');
    const input = context(); input.source.connectionId = 'another-connection';
    await expect(openFileSource(input)).rejects.toThrow('来源绑定与连接不匹配');
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it('rejects disconnected or revoked connections and bindings before consulting the provider', async () => {
    const fixture = fixtureDriver();
    for (const owner of ['connection', 'source'] as const) for (const status of ['disconnected', 'revoked'] as const) {
      const input = context(); input[owner].status = status;
      await expect(openFileSource(input)).rejects.toThrow();
    }
    expect(fixture.open).not.toHaveBeenCalled(); expect(cache.get).not.toHaveBeenCalled();
  });

  it('disposes late provider opens invalidated by either the connection or its stable item', async () => {
    const fixture = fixtureDriver();
    for (const itemId of [undefined, 'same-file']) {
      const pending = deferred<RandomAccessSource>();
      const late = {snapshot: {identity: 'late', version: 'v1', size: 32, local: false}, readAt: vi.fn(), validate: vi.fn(), close: vi.fn(async () => {})};
      fixture.open.mockReturnValueOnce(pending.promise);
      const opening = openFileSource(context());
      await closeSourceAccess({connectionId: context().connection.id, itemId});
      const rejected = expect(opening).rejects.toMatchObject({name: 'AbortError'});
      pending.resolve(late); await rejected;
      expect(late.close).toHaveBeenCalledTimes(1); expect(late.readAt).not.toHaveBeenCalled();
    }
    expect(cache.get).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled();
  });

  it('never touches the range cache for local bytes or providers that disable it', async () => {
    const local = fixtureDriver({id: 'fixture-local', local: true});
    const remote = fixtureDriver({id: 'fixture-uncached', cacheRanges: false});
    for (const fixture of [local, remote]) {
      const source = await open(context(fixture.driver.id));
      expect([...await source.readAt(0, 2)]).toEqual([7, 7]);
      await source.readAt(0, 2);
      expect(fixture.sources[0].readAt).toHaveBeenCalledTimes(2);
    }
    expect(cache.get).not.toHaveBeenCalled(); expect(cache.token).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled();
  });

  it('isolates providers, connections, stable items and versions while sharing an unchanged item across documents', async () => {
    const one = fixtureDriver(), two = fixtureDriver({id: 'second-provider'});
    const cases = [context(), context('second-provider', undefined, undefined, 'v1', 8),
      context('fixture-files', 'fixture-files:another-reader', undefined, 'v1', 9),
      context('fixture-files', undefined, 'another-file', 'v1', 10),
      context('fixture-files', undefined, undefined, 'v2', 11)];
    for (const [index, input] of cases.entries()) {
      const source = await open(input);
      expect([...await source.readAt(4, 2)]).toEqual([index + 7, index + 7]);
    }
    expect(saved.size).toBe(5);
    const same = context(); same.entryId = 'another-document'; same.contentId = 'another-catalog-revision';
    const shared = await open(same);
    expect([...await shared.readAt(4, 2)]).toEqual([7, 7]);
    expect(one.sources.at(-1)!.readAt).not.toHaveBeenCalled();
    expect(two.sources[0].readAt).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(5);
  });

  it('closes only the selected item, discards its late bytes, and can then close the remaining connection', async () => {
    const fixture = fixtureDriver();
    const first = await open(), sibling = await open(context('fixture-files', undefined, 'another-file'));
    const anotherAccount = await open(context('fixture-files', 'fixture-files:another-reader'));
    const pending = deferred<Uint8Array>(); fixture.sources[0].readAt.mockReturnValueOnce(pending.promise);
    const reading = first.readAt(0, 2);
    await vi.waitFor(() => expect(fixture.sources[0].readAt).toHaveBeenCalledTimes(1));
    await closeSourceAccess({connectionId: context().connection.id, itemId: 'same-file'});
    const rejected = expect(reading).rejects.toMatchObject({name: 'AbortError'});
    pending.resolve(new Uint8Array([1, 2])); await rejected;
    expect(cache.put).not.toHaveBeenCalled();
    expect(fixture.sources[0].close).toHaveBeenCalledTimes(1);
    expect(fixture.sources[1].close).not.toHaveBeenCalled();
    expect([...await sibling.readAt(0, 2)]).toEqual([7, 7]);
    await closeSourceAccess({connectionId: context().connection.id});
    await expect(sibling.readAt(0, 2)).rejects.toMatchObject({name: 'AbortError'});
    expect(fixture.sources[1].close).toHaveBeenCalledTimes(1);
    expect([...await anotherAccount.readAt(0, 2)]).toEqual([7, 7]);
    expect(fixture.sources[2].close).not.toHaveBeenCalled();
  });

  it('discards late uncached/local reads and validations after explicit close', async () => {
    for (const options of [{id: 'uncached-files', cacheRanges: false}, {id: 'local-files', local: true}]) {
      const fixture = fixtureDriver(options), source = await open(context(options.id));
      const bytes = deferred<Uint8Array>(), status = deferred<'unchanged'>();
      fixture.sources[0].readAt.mockReturnValueOnce(bytes.promise); fixture.sources[0].validate.mockReturnValueOnce(status.promise);
      const reading = source.readAt(0, 2), validating = source.validate();
      await source.close();
      const rejected = [expect(reading).rejects.toMatchObject({name: 'AbortError'}), expect(validating).rejects.toMatchObject({name: 'AbortError'})];
      bytes.resolve(new Uint8Array([1, 2])); status.resolve('unchanged'); await Promise.all(rejected);
      expect(fixture.sources[0].close).toHaveBeenCalledTimes(1);
    }
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('rejects late cache hits after connection closure without reopening the remote source', async () => {
    const fixture = fixtureDriver(), source = await open(), lookup = deferred<Blob>();
    cache.get.mockReturnValueOnce(lookup.promise);
    const reading = source.readAt(0, 2);
    await closeSourceAccess({connectionId: context().connection.id});
    const rejected = expect(reading).rejects.toMatchObject({name: 'AbortError'});
    lookup.resolve(new Blob([new Uint8Array([1, 2])])); await rejected;
    expect(fixture.sources[0].readAt).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled();
  });

  it('keeps source bytes usable through ordinary cache failures but propagates schema failures at every cache stage', async () => {
    fixtureDriver();
    for (const stage of ['get', 'token', 'put'] as const) {
      saved.clear();
      cache[stage].mockRejectedValueOnce(new DOMException('Cache is full', 'QuotaExceededError'));
      expect([...await (await open()).readAt(0, 2)]).toEqual([7, 7]);
      saved.clear();
      const invalidSchema = new SourceDatabaseSchemaError('source-ranges', `缺少 ${stage}`);
      cache[stage].mockRejectedValueOnce(invalidSchema);
      await expect((await open()).readAt(0, 2)).rejects.toBe(invalidSchema);
    }
  });

  it('disposes a source when opening is cancelled, and validates byte boundaries before cache or provider reads', async () => {
    const fixture = fixtureDriver(), pending = deferred<RandomAccessSource>(), controller = new AbortController();
    const late = {snapshot: {identity: 'late', version: 'v1', size: 32, local: false}, readAt: vi.fn(), validate: vi.fn(), close: vi.fn(async () => {})};
    fixture.open.mockReturnValueOnce(pending.promise);
    const opening = openFileSource({...context(), signal: controller.signal}); controller.abort();
    const rejected = expect(opening).rejects.toMatchObject({name: 'AbortError'}); pending.resolve(late); await rejected;
    expect(late.close).toHaveBeenCalledTimes(1);
    const source = await open();
    for (const [offset, length] of [[-1, 1], [31, 2], [0, 1.5]]) await expect(source.readAt(offset, length)).rejects.toBeInstanceOf(RangeError);
    expect(fixture.sources[0].readAt).not.toHaveBeenCalled(); expect(cache.get).not.toHaveBeenCalled();
  });
});
