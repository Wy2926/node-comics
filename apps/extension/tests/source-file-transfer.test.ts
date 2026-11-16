import {afterEach, describe, expect, it, vi} from 'vitest';
import {consumeSourceFile, serveSourceFile} from '../src/sources/runtime/file';
import {IMAGE_CHUNK_BYTES} from '../src/inline/blob-transfer';
import {pair} from './runtime-port-fixture';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const bytes = new Uint8Array(IMAGE_CHUNK_BYTES * 2 + 37).fill(73);
  const file = new File([bytes], 'Book.epub', {type: 'application/epub+zip'});
  const controller = new AbortController(), page = {url: 'https://source.test/reader', navigationId: 'document-one', controller,
    session: {openFile: vi.fn(async () => ({id: 'book-one', file}))}};
  const ports: ReturnType<typeof pair>[] = [];
  const ticket = {url: page.url, navigationId: page.navigationId, tabId: 8, id: 'book-one', name: file.name, size: file.size};
  vi.stubGlobal('chrome', {runtime: {}, storage: {session: {get: async () => ({'nc-file:fixture': ticket}), remove: vi.fn()}},
    tabs: {connect: vi.fn(() => {const p = pair(); ports.push(p); serveSourceFile(p.remote, () => page as any); return p.port;})}});
  return {file, bytes, page, ports, ticket};
}
describe('selected source file streams', () => {
  it('streams exact bytes on demand and retries a cancelled copy without buffering the complete file', async () => {
    const f = fixture(), selected = await consumeSourceFile('fixture'), reader = selected.stream().getReader();
    await vi.waitFor(() => expect(f.ports[0].server.postMessage).toHaveBeenCalled());
    expect(f.ports[0].client.postMessage.mock.calls.map(([v]) => v.type)).toEqual(['open']);
    expect((await reader.read()).value).toEqual(f.bytes.slice(0, IMAGE_CHUNK_BYTES));
    await reader.cancel();
    expect(f.ports[0].client.disconnect).toHaveBeenCalled();
    const all = new Uint8Array(await new Response(selected.stream()).arrayBuffer());
    expect(all).toEqual(f.bytes);
    expect(f.page.session.openFile).toHaveBeenCalledTimes(2);
  });
  it('rejects another selection or document instead of importing it under the saved name', async () => {
    for (const change of ['id', 'name', 'size', 'navigationId'] as const) {
      const f = fixture(), selected = await consumeSourceFile('fixture');
      if (change === 'navigationId') f.page.navigationId = 'other-document';
      else f.ticket[change] = (change === 'size' ? f.ticket.size + 1 : 'other') as never;
      await expect(new Response(selected.stream()).arrayBuffer()).rejects.toThrow();
    }
  });
  it('rejects navigation during copying and releases the pending transport', async () => {
    const f = fixture(), selected = await consumeSourceFile('fixture'), reader = selected.stream().getReader();
    await reader.read(); f.page.controller.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(f.ports[0].client.disconnect).toHaveBeenCalled();
  });
});
