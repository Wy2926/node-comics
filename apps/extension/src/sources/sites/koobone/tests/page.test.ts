import {afterEach, describe, expect, it, vi} from 'vitest';
import {definition} from '../definition';
import {createPage} from '../page';

const url = 'https://koobone.com/web.htm', blob = 'blob:https://koobone.com/fixture';
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const doc = {URL: 'https://koobone.com/wpage.htm?9', defaultView: {location: {href: 'https://koobone.com/wpage.htm?9'}, frameElement: null as unknown},
    querySelectorAll: () => images};
  const image = (id: string, src = blob) => ({id, src, currentSrc: '', complete: true, naturalWidth: 800, naturalHeight: 1100,
    isConnected: true, ownerDocument: doc, matches: () => true});
  const images = [image('img_left'), image('img_right'), image('placeholder', 'https://koobone.com/blank.png')];
  const frame = {isConnected: true, src: doc.URL, contentDocument: doc, checkVisibility: () => true,
    getBoundingClientRect: () => ({width: 800, height: 600})};
  doc.defaultView.frameElement = frame;
  const controller = new AbortController();
  const document = {title: 'KOOBONE', querySelector: (selector: string) => selector === 'iframe#iframe_page' ? frame : null} as unknown as Document;
  const page = createPage({document, location: definition.identify(new URL(url))!, signal: controller.signal});
  return {page, frame, doc, images};
}

describe('KOOBONE inline reader', () => {
  it('claims only the HTTPS desktop reader and declares no import or full-book acquisition', async () => {
    expect(definition.identify(new URL(url + '?v=1#reader'))?.kind).toBe('reader');
    for (const target of ['http://koobone.com/web.htm', 'https://koobone.com.evil.test/web.htm',
      'https://user@koobone.com/web.htm', 'https://koobone.com:444/web.htm',
      'https://kxo.moe/c/10281.htm', 'https://koobone.com/login.php', 'https://koobone.com/wpage.htm']) {
      expect(definition.identify(new URL(target))).toBeNull();
    }
    expect(definition.capabilities).toMatchObject({inline: true, importable: false, catalog: false, pages: false, completePageList: false});
    expect(definition.installation).toEqual({autoContentMatches: []});
    const {page} = fixture();
    expect(await page.discoverPages()).toEqual({status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'});
    expect(page.snapshot()).toMatchObject({items: [], discoveryComplete: false}); page.dispose();
  });

  it('keeps duplicated Blob pages distinct, excludes placeholders, and changes identity when a slot turns', () => {
    const {page, images, frame} = fixture();
    const targets = page.inlineTargets();
    expect(targets.map(t => t.element)).toEqual(images.slice(0, 2));
    expect(targets[0].key).not.toBe(targets[1].key);
    images[0].src = blob + '-next'; expect(page.inlineTargets()[0].key).not.toBe(targets[0].key);
    images[0].complete = false; expect(page.inlineTargets()).toHaveLength(1);
    frame.checkVisibility = () => false; expect(page.inlineTargets()).toEqual([]); page.dispose();
  });

  it('expires reads when reader frames are replaced, hidden or navigated, including during a read', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {f.frame.contentDocument = {...f.doc};},
      (f: ReturnType<typeof fixture>) => {f.frame.isConnected = false;},
      (f: ReturnType<typeof fixture>) => {f.frame.checkVisibility = () => false;},
      (f: ReturnType<typeof fixture>) => {f.frame.src = 'https://foreign.test/wpage.htm';},
      (f: ReturnType<typeof fixture>) => {f.doc.URL = 'https://foreign.test/wpage.htm';},
      (f: ReturnType<typeof fixture>) => {f.doc.defaultView.frameElement = null;},
    ]) {
      const f = fixture(), target = f.page.inlineTargets()[0]; mutate(f);
      await expect(target.read!()).rejects.toThrow('SOURCE_RESOURCE_EXPIRED'); f.page.dispose();
    }
    // Image/Blob invalidation and cancellation belong to shared/blob-image.test.ts;
    // this adapter additionally binds reads to the enclosing reader frame.
    const {page, doc, frame} = fixture(), target = page.inlineTargets()[0];
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>(r => {resolve = r;}));
    const pending = target.read!();
    frame.src = 'https://koobone.com/login.php'; resolve(new Response('original'));
    await expect(pending).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
    expect(page.inlineTargets()).toEqual([]);
    frame.src = doc.URL; page.dispose();
    await expect(target.read!()).rejects.toThrow();
  });
});
