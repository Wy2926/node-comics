import {afterEach, describe, expect, it, vi} from 'vitest';
import type {SourcePageContext} from '../../../contracts/page';
import {gigaViewerPages} from '../pages';
import {bakuDimensions, decodeBaku} from '../image';
import {gigaViewerPage} from '../page';

afterEach(() => vi.unstubAllGlobals());
const structure = () => ({choJuGiga: 'baku', readingDirection: 'rtl', pages: [
  {type: 'main', width: 1125, height: 1600, src: 'https://images.example/a'}, {type: 'other'},
  {type: 'main', width: 1125, height: 1600, src: 'https://images.example/a'}, {type: 'backMatter'},
]});
const pageUrl = (value: unknown) => {if (typeof value !== 'string' || !value.startsWith('https://images.example/')) throw Error(); return value;};
describe('GigaViewer engine independent of a site', () => {
  it.each(['baku', 'usagi', '', undefined, null])('validates known mode %s without inventing another decoder', mode => {
    const value = {...structure(), choJuGiga: mode};
    const result = gigaViewerPages(value, pageUrl);
    expect(result.items.map(p => p.id)).toEqual(['page-0', 'page-2']);
    expect(result.items[0].resource).toEqual({kind: 'http', url: 'https://images.example/a',
      ...(mode === 'baku' ? {processing: 'gigaviewer-baku:1125:1600'} : {})});
  });
  it.each(['mode', 'empty', 'type', 'dimensions', 'url', 'count'])('rejects invalid %s metadata', mode => {
    const value = structure();
    if (mode === 'mode') value.choJuGiga = 'future-format';
    if (mode === 'empty') value.pages = [];
    if (mode === 'type') value.pages[0].type = 'unknown';
    if (mode === 'dimensions') value.pages[0].width = 0;
    if (mode === 'url') value.pages[0].src = 'https://foreign.example/image';
    if (mode === 'count') value.pages = Array.from({length: 1501}, () => value.pages[0]);
    expect(() => gigaViewerPages(value, pageUrl)).toThrow();
  });
  it('does not put upload dimension limits in source discovery', () => {
    const value = structure(); value.pages[0].height = 100000;
    expect(gigaViewerPages(value, pageUrl).items[0].height).toBe(100000);
    expect(() => bakuDimensions('gigaviewer-baku:1125:1600:')).toThrow();
  });
  it('keeps 38-page steady scans and invalid metadata parsing bounded to one parse per revision', () => {
    let raw = JSON.stringify(structure());
    const pages = Array.from({length: 38}, (_, i) => ({...structure().pages[0], src: 'https://images.example/' + i}));
    raw = JSON.stringify({...structure(), pages});
    const parse = vi.fn((value: unknown, url: string) => ({url, adapter: 'fixture', title: '', note: '', discoveryComplete: true,
      ...gigaViewerPages(value, pageUrl)}));
    const areas = pages.map(p => ({querySelector: () => ({width: p.width, height: p.height, isConnected: true})}));
    const context = {document: {title: '', querySelector: () => ({getAttribute: () => raw}), querySelectorAll: () => areas},
      signal: new AbortController().signal, location: {url: 'https://fixture.example/episode/11', sourceId: 'fixture', pageKey: '11', kind: 'reader'}} as unknown as SourcePageContext;
    const session = gigaViewerPage(context, parse);
    for (let i = 0; i < 100; i++) expect(session.inlineTargets()).toHaveLength(38);
    expect(parse).toHaveBeenCalledOnce();
    raw = '{}';
    for (let i = 0; i < 100; i++) expect(session.inlineTargets()).toEqual([]);
    expect(parse).toHaveBeenCalledTimes(2);
    raw = JSON.stringify({...structure(), pages}); expect(session.inlineTargets()).toHaveLength(38);
    expect(parse).toHaveBeenCalledTimes(3);
    session.dispose(); expect(() => session.inlineTargets()).toThrow();
  });
  it('invalidates native reads on resize, rebind, metadata mode change and disposal', async () => {
    let value = {...structure(), choJuGiga: 'usagi'};
    const canvas = {width: 1125, height: 1600, isConnected: true,
      toBlob: vi.fn((done: (blob: Blob) => void) => done(new Blob(['original'])))};
    let element = canvas;
    const context = {document: {title: '', querySelector: () => ({getAttribute: () => JSON.stringify(value)}),
      querySelectorAll: () => [{querySelector: () => element}, {querySelector: () => null}]},
      signal: new AbortController().signal, location: {url: 'https://fixture.example/episode/11', sourceId: 'fixture', pageKey: '11', kind: 'reader'}} as unknown as SourcePageContext;
    const session = gigaViewerPage(context, (value, url) => ({url, adapter: 'fixture', title: '', note: '', discoveryComplete: true,
      ...gigaViewerPages(value, pageUrl)}));
    const target = session.inlineTargets()[0]; expect(await target.read!()).toBeInstanceOf(Blob);
    canvas.width = 0; await expect(target.read!()).rejects.toThrow('EXPIRED'); canvas.width = 1125;
    element = {...canvas}; await expect(target.read!()).rejects.toThrow('EXPIRED'); element = canvas;
    value = {...value, choJuGiga: 'baku'}; await expect(target.read!()).rejects.toThrow('EXPIRED');
    session.dispose(); await expect(target.read!()).rejects.toThrow(); expect(canvas.toBlob).toHaveBeenCalledOnce();
  });
  it('releases decoded resources on late cancellation and rejects unknown processing', async () => {
    const controller = new AbortController(), bitmap = {width: 1125, height: 1600, close: vi.fn()};
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {controller.abort(); return bitmap;}));
    await expect(decodeBaku(new Blob(), undefined, controller.signal)).rejects.toThrow();
    expect(bitmap.close).toHaveBeenCalledOnce();
    for (const value of ['wrong:1:1', 'gigaviewer-baku:-1:1', 'gigaviewer-baku:1.5:1', 'gigaviewer-baku:1:Infinity'])
      expect(() => bakuDimensions(value)).toThrow();
  });
  it.each(['success', 'failure', 'cancel'])('releases the temporary canvas after encoding %s', async state => {
    const controller = new AbortController(), bitmap = {width: 1125, height: 1600, close: vi.fn()}, blob = new Blob(['png']);
    const surface = {width: bitmap.width, height: bitmap.height, getContext: () => ({drawImage() {}}),
      async convertToBlob() {if (state === 'failure') throw Error('encode failed'); if (state === 'cancel') controller.abort(); return blob;}};
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('OffscreenCanvas', class {constructor() {return surface;}});
    const result = decodeBaku(new Blob(), undefined, controller.signal);
    if (state === 'success') expect(await result).toBe(blob); else await expect(result).rejects.toThrow();
    expect(bitmap.close).toHaveBeenCalledOnce(); expect([surface.width, surface.height]).toEqual([1, 1]);
  });
});
