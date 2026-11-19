import {afterEach, describe, expect, it, vi} from 'vitest';
import type {SourceNetworkContext} from '../../../contracts/network';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {catalogUrl, definition, origin} from '../definition';
import {image} from '../image';
import {network} from '../network';
import {createPage} from '../page';

const work = catalogUrl('12'), reader = origin + '/viewer/34', bound = reader + '#nodelane-mangaplus=12';
const asset = 'https://jumpg-assets3.tokyo-cdn.com/secure/title/12/chapter/34/manga_page/high/1.jpg';
const key = 'ab'.repeat(64), token = 'bc'.repeat(16);
const page = {imageUrl:asset + '?hash=fixture&expires=9999999999', width:1080, height:1620, encryptionKey:key};
const viewer = () => ({chapterId:34, titleId:12, chapterName:'#001', isVerticalOnly:false, vwToken:token,
  pages:[{mangaPage:page}, {insertBannerList:{}}, {advertisement:{}}, {mangaPage:{...page, imageUrl:page.imageUrl.replace('1.jpg','2.jpg')}}, {lastPage:{}}]});
const chapter = (id:number) => ({titleId:12, chapterId:id, name:'#' + id, subTitle:'Fixture', chapterType:0});
function context(url:string, model:object, catalog = false):SourceNetworkContext {
  vi.stubGlobal('location', new URL(url));
  vi.stubGlobal('document', {[Symbol.for('nc-source-page-document')]:'fixture', querySelector:(selector:string) =>
    selector === (catalog ? '#app' : '.zao') ? {__vue__:catalog ? {$store:{state:{detail:{model:{12:model}}}}} : {model}} : null});
  return {request:vi.fn(), readDocument:async project => (await project({pageUrl:url, documentToken:'fixture', cancelEvent:''}))!};
}
afterEach(() => vi.unstubAllGlobals());
describe('MANGA Plus web edition', () => {
  it('recognizes SPA routes and preserves chapter identity with or without a title binding', () => {
    expect(definition.identify(new URL(reader + '?from=home'))?.pageKey).toBe(definition.identify(new URL(bound))?.pageKey);
    expect(definition.identify(new URL(bound))?.catalog?.url).toBe(work);
    for (const url of [origin+'/', origin+'/viewer/0034', reader+'#nodelane-mangaplus=bad'])
      expect(definition.identify(new URL(url))?.kind).toBe('other');
    expect(definition.identify(new URL(origin.replace('.jp', '.jp.example')+'/titles/12'))).toBeNull();
  });
  it('imports exactly the web directory, keeps app-only neighbors unavailable and editions separate', async () => {
    const model = {title:{titleId:12, language:1, name:'Fixture'}, chapterContentList:[
      {chapter:chapter(34)}, {middleChapters:{middleChapterList:[chapter(35)]}}, {chapter:chapter(37)}]};
    const source = validateCatalog(await network.catalog(work, context(work, model, true)), [definition]);
    expect(source.entries.map(e => [e.url, e.readable, e.contentLanguage])).toEqual([
      [bound,true,'es'], [bound.replace('34','35'),false,'es'], [bound.replace('34','37'),true,'es']]);
    expect(source.defaultEntryId).toBe(source.entries[0].id);
    model.chapterContentList.push({chapter:chapter(34)});
    await expect(network.catalog(work, context(work, model, true))).rejects.toThrow();
  });
  it('resolves an unbound chapter and imports manga pages only; session material never enters the manifest', async () => {
    expect(await network.resolveCatalog(reader, context(reader,viewer()))).toBe(work);
    const snapshot = validatePages(await network.pages(bound, context(bound,viewer())), definition.identify(new URL(bound))!);
    expect(snapshot.knownTotal).toBe(2);
    expect(snapshot.items.map(p => p.resource)).toEqual([{kind:'http',url:asset},{kind:'http',url:asset.replace('1.jpg','2.jpg')}]);
    const serialized = JSON.stringify(snapshot);
    for (const secret of ['?hash=',token,key]) expect(serialized).not.toContain(secret);
    const request = image.resolvePage(asset);
    expect(request).toEqual({url:page.imageUrl, headers:{'Plus-Vw-Token':token}, processing:key});
    const bytes = Uint8Array.of(0xff,0xd8,0xff,0xe0);
    const decoded = await image.decode(new Blob([bytes.map(b => b ^ 0xab)]), new Headers(), request.processing, undefined);
    expect(decoded.type).toBe('image/jpeg');
    expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(bytes);
  });
  it('rejects a different title, a foreign asset origin and unrecognized page kinds', async () => {
    await expect(network.pages(bound, context(bound,{...viewer(),titleId:13}))).rejects.toThrow();
    for (const row of [{mangaPage:{...page,imageUrl:asset.replace('.com','.com.example')}}, {unknownPage:{}}])
      await expect(network.pages(bound, context(bound,{...viewer(),pages:[row]}))).rejects.toThrow();
    expect(() => image.resolvePage(asset.replace('.com','.com.example'))).toThrow();
  });
  it('selects loaded viewer blobs for inline translation, never the currently rendered subset as a full chapter', async () => {
    const img = {src:'blob:'+origin+'/fixture', complete:true, naturalWidth:800, naturalHeight:1200};
    const querySelectorAll = vi.fn(() => [img, {...img,complete:false}, {...img,src:'https://example.org/ad.jpg'}]);
    const session = createPage({document:{querySelectorAll} as unknown as Document, location:definition.identify(new URL(reader))!,
      signal:new AbortController().signal});
    expect(session.inlineTargets().map(t => t.element)).toEqual([img]);
    expect(querySelectorAll.mock.calls[0]).toEqual(['.zao .zao-page > .zao-image-container > img.zao-image']);
    expect((await session.discoverPages()).status).toBe('unsupported');
    session.dispose();
  });
});
