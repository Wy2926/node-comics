import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpdsProvider } from '../src/comics/sources/opds/provider';
import { PrivateOpdsStore } from '../src/comics/sources/opds/private-store';
import { registerSourceDriver } from '../src/comics/sources/registry';
import { openFileSource, closeSourceAccess } from '../src/comics/sources/runtime';
import { connectRemoteLibrary, browseRemoteLibrary, openRemotePublication } from '../src/comics/application/remote-library-service';
import { openEpubArchive } from '../src/comics/formats/epub/archive';
import { entrySource } from '../src/comics/application/entry-source';
import { catalog } from '../src/comics/repositories';
import { removeComic, loadEntry, saveReaderState } from '../src/comics/application/library-service';
import {ReadingProgress} from '../src/comics/application/reading-progress';
import { installTestXmlParser } from './opds-protocol-dom';
import { startEpubRangeServer } from './fixtures/opds-epub-server';

installTestXmlParser();
const cleanup: (() => void | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(level: 0 | 6 = 0) {
  const server = await startEpubRangeServer(level);
  cleanup.push(server.close);
  const provider = createOpdsProvider({ store: new PrivateOpdsStore('epub-range-' + crypto.randomUUID()) });
  cleanup.push(registerSourceDriver(provider));
  const connection = await connectRemoteLibrary('opds', { name: 'Range fixture', auth: 'anonymous', url: server.origin + '/opds' });
  cleanup.push(() => provider.connection!.disconnect!(connection));
  const page = await browseRemoteLibrary(connection.id);
  return { server, provider, connection, publication: (name = 'book') => page.publications.find((item) => item.title === 'EPUB ' + name)! };
}

describe('EPUB lazy loading over real loopback HTTP', () => {
  it.each([0, 6] as const)('indexes ZIP level %s without a full transfer, reads chapters on demand, and reuses cached ranges', async (level) => {
    const { server, connection, publication } = await setup(level);
    const opened = await openRemotePublication(connection.id, publication().id);
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') throw Error('Expected lazy reading');
    cleanup.push(() => removeComic(opened.comicId));
    const binding = await entrySource(opened.entryId);
    expect(binding.entry).toMatchObject({ format: 'epub', acquisition: { kind: 'range-file' }, document: { kind: 'epub' } });
    expect(binding.entry.containerId).toBeUndefined();
    expect(await catalog.listPages(binding.entry.contentId)).toEqual([]);
    const indexedBytes = server.requests.reduce((total, request) => total + request.bytes, 0);
    expect(indexedBytes).toBeLessThan(server.bytes.length / 10);
    const requestsAfterIndex = server.requests.length;
    expect(requestsAfterIndex).toBeLessThan(8);
    const source = await openFileSource(binding.context);
    cleanup.push(() => source.close());
    const archive = await openEpubArchive(source);
    cleanup.push(() => archive.close());
    // Metadata ranges are handed from the pending index owner to the actual reading entry.
    expect(server.requests).toHaveLength(requestsAfterIndex);
    expect(await archive.text('OPS/one.xhtml')).toContain('Chapter One');
    const firstChapterRequests = server.requests.length;
    expect(firstChapterRequests).toBeGreaterThanOrEqual(requestsAfterIndex);
    await archive.text('OPS/one.xhtml');
    expect(server.requests).toHaveLength(firstChapterRequests);
    expect(await archive.text('OPS/two.xhtml')).toContain('Chapter Two');
    expect(server.requests.length).toBeGreaterThanOrEqual(firstChapterRequests);
    expect(server.requests.every((request) => request.status === 206 && request.range)).toBe(true);
    expect(server.requests.slice(1).every((request) => request.ifMatch === '"fixture-v1"')).toBe(true);
    expect(server.requests.reduce((total, request) => total + request.bytes, 0)).toBeLessThan(server.bytes.length / 5);
    console.info(JSON.stringify({ fixture: 'epub-range', level, fileBytes: server.bytes.length, indexedBytes, indexRequests: requestsAfterIndex, twoChapterBytes: server.requests.reduce((total, request) => total + request.bytes, 0), requests: server.requests.length }));
  });

  it.each(['no-range', 'weak', 'fresh-modified'])('asks for an explicit download when %s cannot prove a stable snapshot', async (name) => {
    const { server, connection, publication } = await setup();
    const opened = await openRemotePublication(connection.id, publication(name).id);
    expect(opened).toMatchObject({ kind: 'download-required', plan: { format: 'epub' } });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].range).toBe('bytes=0-0');
  });

  it.each(['last-modified','weak-modified'])('streams %s without a strong ETag or a local container',async(name)=>{
    const {server,connection,publication}=await setup();
    const opened=await openRemotePublication(connection.id,publication(name).id);
    if(opened.kind!=='opened')throw Error('Expected streaming EPUB');
    cleanup.push(()=>removeComic(opened.comicId));
    const {context,entry}=await entrySource(opened.entryId);
    expect(entry.containerId).toBeUndefined();
    expect(entry.acquisition?.kind).toBe('range-file');
    const source=await openFileSource(context);cleanup.push(()=>source.close());
    const archive=await openEpubArchive(source);cleanup.push(()=>archive.close());
    expect(await archive.text('OPS/one.xhtml')).toContain('Chapter One');
    expect(server.requests.every(request=>request.status===206&&request.range)).toBe(true);
    expect(server.requests.slice(1).every(request=>request.ifUnmodifiedSince===server.state.lastModified&&!request.ifMatch)).toBe(true);
    expect(server.requests.reduce((total,request)=>total+request.bytes,0)).toBeLessThan(server.bytes.length/5);
    server.state.lastModified='Tue, 02 Jan 2024 00:00:00 GMT';
    await expect(archive.text('OPS/two.xhtml')).rejects.toMatchObject({code:'source-changed',details:{status:412}});
  });

  it.each(['book','sync-unsupported','sync-fails'])('retains EPUB local progress on immediate reopen with %s',async(name)=>{
    const {server,connection,publication}=await setup();
    const opened=await openRemotePublication(connection.id,publication(name).id);
    if(opened.kind!=='opened')throw Error('Expected streaming EPUB');
    cleanup.push(()=>removeComic(opened.comicId));
    const status=vi.fn(),sync=new ReadingProgress(undefined,status);
    cleanup.push(()=>sync.close());
    const copy=await sync.open(await loadEntry(opened.entryId));
    const moved={...copy,documentLocation:{href:'OPS/two.xhtml',cfi:'epubcfi(/6/4!/4/4/1:12)',progression:.45,totalProgression:.725},lastReadAt:Date.now()};
    const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const savePosition=catalog.savePosition.bind(catalog);
    const save=vi.spyOn(catalog,'savePosition').mockImplementationOnce(async(position)=>{started.resolve();await release.promise;await savePosition(position);});
    cleanup.push(()=>save.mockRestore());
    const saving=saveReaderState(moved);
    await started.promise;
    sync.update(moved);
    let loaded=false;
    const reopening=loadEntry(copy.id).then(value=>{loaded=true;return value;});
    await Promise.resolve();expect(loaded).toBe(false);
    release.resolve();await saving;await sync.close();
    const restored=await sync.open(await reopening);
    expect(restored.documentLocation).toEqual(moved.documentLocation);
    expect(restored.lastReadAt).toBe(moved.lastReadAt);
    expect(status).toHaveBeenLastCalledWith(name==='sync-fails'?'pending':'local');
    expect(server.requests.filter(request=>request.path.startsWith('/progress/'))).toHaveLength(name==='book'?0:name==='sync-unsupported'?2:3);
  });

  it('keeps large reads in one request and caches them without small-block fanout', async () => {
    const { server, connection, publication } = await setup();
    const opened = await openRemotePublication(connection.id, publication().id);
    if (opened.kind !== 'opened') throw Error('Expected lazy reading');
    cleanup.push(() => removeComic(opened.comicId));
    const { context } = await entrySource(opened.entryId);
    const source = await openFileSource(context);
    cleanup.push(() => source.close());
    const before = server.requests.length, offset = 256 * 1024, length = 512 * 1024;
    expect(await source.readAt(offset, length)).toEqual(server.bytes.subarray(offset, offset + length));
    expect(server.requests).toHaveLength(before + 1);
    expect(server.requests.at(-1)?.range).toBe(`bytes=${offset}-${offset + length - 1}`);
    expect(await source.readAt(offset, length)).toEqual(server.bytes.subarray(offset, offset + length));
    expect(server.requests).toHaveLength(before + 1);
  });

  it.each([
    { name: 'denied', status: 403, code: 'access-denied' },
    { name: 'expired', status: 401, code: 'authentication-required' },
  ])('preserves $status without retrying a full download', async ({ name, status, code }) => {
    const { server, connection, publication } = await setup();
    await expect(openRemotePublication(connection.id, publication(name).id)).rejects.toMatchObject({ code, details: { status } });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ status, range: 'bytes=0-0' });
  });

  it('rejects a changed file during chapter reading and closes cached access on revocation', async () => {
    const { server, connection, publication } = await setup();
    const opened = await openRemotePublication(connection.id, publication().id);
    if (opened.kind !== 'opened') throw Error('Expected lazy reading');
    cleanup.push(() => removeComic(opened.comicId));
    const { context } = await entrySource(opened.entryId);
    const source = await openFileSource(context);
    cleanup.push(() => source.close());
    const archive = await openEpubArchive(source);
    cleanup.push(() => archive.close());
    server.state.etag = '"fixture-v2"';
    await expect(archive.text('OPS/two.xhtml')).rejects.toMatchObject({ code: 'source-changed', details: { status: 412 } });
    const requests = server.requests.length;
    await closeSourceAccess({ connectionId: connection.id });
    await expect(archive.text('OPS/one.xhtml')).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.requests).toHaveLength(requests);
  });
});
