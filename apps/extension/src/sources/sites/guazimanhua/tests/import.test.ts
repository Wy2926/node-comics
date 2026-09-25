import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {registerSourceBackground} from '../../../runtime/background';
import {catalog} from '../../../../comics/repositories';
import {importCatalog,importManifest} from '../../../../comics/application/import-service';
import {importWebsiteLink} from '../../../../comics/application/website-import';
import {readNetworkPages} from '../../../runtime/network';
import {readImportCatalog} from '../../../runtime/import';
import {parseCatalog} from '../network';
import {catalogHtml, reader, readerHtml, url} from './fixtures';
vi.mock('../../../../i18n/background', () => ({registerLocaleBackground: () => async () => {}}));
vi.mock('../../../../inline/background', () => ({activateInline: vi.fn(), registerInlineBackground: vi.fn()}));
afterEach(async () => {vi.unstubAllGlobals();for(const comic of await catalog.list('comics'))await catalog.deleteComic(comic.id);});

describe.each(['embedded','popup'])('%s reader imports',entry=>{
it.each(['valid', 'missing-chapter', 'foreign-parent', 'failed-request'])('resolves reader import over HTTP: %s', async mode => {
  let listener: (message: unknown, sender: unknown, reply: (value: unknown) => void) => unknown;
  const create = vi.fn(async () => ({id: 8})), set = vi.fn(async (_values: Record<string, unknown>) => {});
  vi.stubGlobal('chrome', {
    runtime: {id: 'test', getURL: (path: string) => 'chrome-extension://test' + path,
      onInstalled: {addListener() {}}, onMessage: {addListener(fn: typeof listener) {listener = fn;}}},
    contextMenus: {onClicked: {addListener() {}}}, storage: {local: {set}},
    tabs: {get: async () => ({id: 7, url: reader}), create},
  });
  const fetcher = vi.fn(async () => {
    if (mode === 'failed-request') throw Error('HTTP unavailable');
    return new Response(mode === 'foreign-parent' ? readerHtml().replaceAll(url, 'https://evil.test/comic.php?id=123') : readerHtml());
  });
  vi.stubGlobal('fetch', fetcher);
  const read = vi.fn(async () => parseCatalog(catalogHtml(mode === 'missing-chapter' ? ['7'] : ['11', '7']), url));
  registerSourceBackground(read);
  const result = await new Promise(resolve => listener({type: entry==='embedded'?'NC_IMPORT_CURRENT':'NC_DISCOVER_TAB',tabId:7}, {id: 'test', url: entry==='embedded'?reader:'chrome-extension://test/popup.html', frameId: 0, tab: {id: 7}}, resolve));
  expect(fetcher).toHaveBeenCalledTimes(1);
  if (mode === 'valid') {
    expect(result).toMatchObject({ok: true});
    expect(read).toHaveBeenCalledWith(url);
    if(entry==='embedded')expect(create).toHaveBeenCalledExactlyOnceWith({url: expect.stringContaining('reader.html?catalog=')});
    else {expect(create).not.toHaveBeenCalled();expect(result).toMatchObject({data:{kind:'catalog'}});expect(result).not.toHaveProperty('data.manifest');}
    const stored = Object.values(set.mock.calls.at(-1)![0] as object)[0] as {catalog: {defaultEntryId: string};selectedEntryId?:string};
    expect(stored.catalog).toEqual(await read.mock.results[0].value);
    expect(stored.selectedEntryId).toBe('guazimanhua:chapter:11');
  } else {
    expect(result).toMatchObject({ok: false});
    expect(create).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  }
});
});

it.each([true,false])('reuses the same work and reading position across link/catalog and chapter entry points (chapter first: %s)',async chapterFirst=>{
  const permissions=vi.fn(async()=>true),fetcher=vi.fn(async(target:string)=>new Response(target.includes('chapter.php')?readerHtml():catalogHtml()));
  vi.stubGlobal('chrome',{runtime:{id:'test'},permissions:{request:permissions},storage:{local:{set:vi.fn()}}});
  vi.stubGlobal('fetch',fetcher);
  const first=await importWebsiteLink(chapterFirst?reader:url);
  expect(permissions.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]);
  const current=(await catalog.listEntries(first.id)).find(entry=>entry.sourceEntryId==='guazimanhua:chapter:11')!;
  await importManifest(await readNetworkPages(current.sourceUrl!));
  const [page]=await catalog.listPages(current.contentId);
  const position={id:current.id,entryId:current.id,comicId:first.id,contentId:current.contentId,pageId:page.pageId,relativeOffset:.4,updatedAt:10};
  await catalog.savePosition(position);
  const fromBackground=await readImportCatalog(reader);
  const repeats=await Promise.all([importWebsiteLink(chapterFirst?url:reader),importCatalog(fromBackground),importCatalog(fromBackground)]);
  expect(repeats.every(comic=>comic.id===first.id)).toBe(true);
  expect(await catalog.list('comics')).toHaveLength(1);expect(await catalog.listEntries(first.id)).toHaveLength(3);
  expect(await catalog.get('positions',current.id)).toEqual(position);
});

it.each(['permission','parent','catalog'])('does not create a work when link import fails at %s',async failure=>{
  vi.stubGlobal('chrome',{runtime:{id:'test'},permissions:{request:vi.fn(async()=>failure!=='permission')}});
  const fetcher=vi.fn(async(target:string)=>new Response(target.includes('chapter.php')?(failure==='parent'?readerHtml().replaceAll(url,'https://evil.test/comic.php?id=123'):readerHtml()):catalogHtml(['7'])));
  vi.stubGlobal('fetch',fetcher);
  await expect(importWebsiteLink(reader)).rejects.toThrow();
  expect(await catalog.list('comics')).toEqual([]);
  if(failure==='permission')expect(fetcher).not.toHaveBeenCalled();
});
