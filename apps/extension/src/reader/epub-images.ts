import type Rendition from 'epubjs/types/rendition';
import type Contents from 'epubjs/types/contents';
import {acquireImage,processingInput} from '../comics/application/image-access';
import {epubImageId} from '../comics/domain/epub-images';
import type {Page, Mode} from '../types';
import {readingImage} from './presentation';
import {prepareReaderImage} from './prepare-image';
import {enhanceImage} from '../image-processing/runtime';
import {activeProcessingProfile, processingIdentity, type ProcessingSettings} from '../image-processing/settings';
import type {ProcessingProfile, ProcessingState} from '../image-processing/contracts';
import {ReadingWindow, READING_TARGETS} from '../reading-window';

interface Artwork {
  section: number;
  element: Element;
  href: string;
  attribute: Attr;
  original: string;
  width: string | null;
  height: string | null;
  visible: boolean;
}
interface Result {
  key: string;
  controller: AbortController;
  url?: string;
  processing: boolean;
  enhancementState?: ProcessingState;
}

/** Only resource attributes change: no text nodes, wrappers, CFI tree or original blobs are replaced. */
export class EpubImageWindow {
  private artwork: Artwork[] = [];
  private byElement = new Map<Element, Artwork>();
  private window: string[] = [];
  private reading = new ReadingWindow<string>(href => href);
  private timer?: ReturnType<typeof setTimeout>;
  private results = new Map<string, Result>();
  private desired = new Map<string, string>();
  private pages = new Map<string, Pick<Page, 'width' | 'height' | 'blobKey'>>();
  private scope = '';
  private profile?: ProcessingProfile;
  private owner = '';
  private enhanceable = new Set<string>();
  private closed = false;
  private observer: IntersectionObserver;

  constructor(private onWindow: (hrefs: string[]) => void, private onError: (href: string, error?: string) => void,
    private onEnhancementChange: () => void = () => {}) {
    // The implicit root includes clipping by the same-origin EPUB iframe and reader viewport.
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const artwork = this.byElement.get(entry.target);
        if (artwork) artwork.visible = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
      }
      this.select();
    });
  }

  connect(view: Rendition) {
    view.hooks.content.register((contents: Contents) => this.add(contents.document, contents.sectionIndex));
    view.hooks.unloaded.register((frame: {contents?: Contents}) => {
      if (frame.contents) this.remove(frame.contents.document);
    });
  }

  add(document: Document, section = 0) {
    if (this.closed || this.artwork.some(value => value.element.ownerDocument === document)) return;
    for (const element of document.querySelectorAll('img[data-nc-epub-image], image[data-nc-epub-image]')) {
      const attribute = Array.from(element.attributes).find(attr => attr.localName === (element.localName === 'img' ? 'src' : 'href'));
      const href = element.getAttribute('data-nc-epub-image');
      if (!attribute || !href) continue;
      const artwork = {section, element, href, attribute, original: attribute.value,
        width: element.getAttribute('width'), height: element.getAttribute('height'), visible: false};
      this.artwork.push(artwork);
      this.byElement.set(element, artwork);
      this.observer.observe(element);
    }
    // A backwards scroll prepends frames; request completion order is not reading order.
    this.artwork.sort((a, b) => a.section - b.section);
    document.addEventListener('load', this.loaded, true);
    this.select();
  }

  private loaded = () => this.apply();

  remove(document: Document) {
    document.removeEventListener('load', this.loaded, true);
    this.artwork = this.artwork.filter(artwork => {
      if (artwork.element.ownerDocument !== document) return true;
      this.restore(artwork);
      this.observer.unobserve(artwork.element);
      this.byElement.delete(artwork.element);
      return false;
    });
    this.select();
  }

  private select() {
    const start = this.artwork.findIndex(value => value.visible);
    const selected = new Set<string>();
    for (let index = start; index >= 0 && index < this.artwork.length && selected.size < READING_TARGETS; index++) selected.add(this.artwork[index].href);
    const next = [...selected];
    if (JSON.stringify(next) !== JSON.stringify(this.window)) {
      this.window = next;
      this.reading.update(next);
      this.apply();
      this.onWindow(next);
    }
  }

  show(pages: Page[], translated: boolean, mode: Mode, language: string, scope?: string, processing?: {owner: string; settings: ProcessingSettings}) {
    const identity = JSON.stringify([scope, language, processing?.owner, processing && processingIdentity(processing.settings)]);
    if (identity !== this.scope) {
      this.scope = identity;
      for (const href of this.results.keys()) this.release(href);
    }
    this.profile = processing && activeProcessingProfile(processing.settings);
    this.owner = processing?.owner ?? '';
    this.pages = new Map(pages.map(page => [page.id, {width: page.width, height: page.height, blobKey: page.blobKey}]));
    this.enhanceable.clear();
    this.desired = new Map(pages.flatMap(page => {
      const result = readingImage(page, mode, translated, language, scope);
      const complete = !translated || !!result.job || !!result.originalResult;
      if (result.key && complete) this.enhanceable.add(page.id);
      return result.key && (result.job || this.profile && complete) ? [[page.id, result.key]] : [];
    }));
    this.apply();
  }

  private apply() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const ready = new Set(this.reading.ready()), delay = this.reading.delay();
    if (this.profile && delay > 0) this.timer = setTimeout(() => this.apply(), delay);
    const wanted = new Map(this.window.flatMap(href => {
      const key = this.desired.get(epubImageId(href));
      return key ? [[href, key]] : [];
    }));
    for (const [href, result] of this.results) if (wanted.get(href) !== result.key || result.processing !== this.shouldEnhance(href)) this.release(href);
    for (const [href, key] of wanted) {
      if (!this.results.has(href) && (!this.shouldEnhance(href) || ready.has(href))) this.load(href, key);
    }
    for (const artwork of this.artwork) {
      const result = this.results.get(artwork.href);
      if (!result?.url) {this.restore(artwork); continue;}
      const {element, attribute} = artwork;
      if (element.localName === 'img') {
        const img = element as HTMLImageElement;
        // Keep the author's intrinsic image box when a channel delivers a smaller bitmap.
        if (artwork.width === null && artwork.height === null && attribute.value === artwork.original) {
          const size = this.pages.get(epubImageId(artwork.href));
          const width = img.naturalWidth || size?.width, height = img.naturalHeight || size?.height;
          if (width && height) {element.setAttribute('width', String(width)); element.setAttribute('height', String(height));}
        }
      }
      if (attribute.value !== result.url) element.setAttributeNS(attribute.namespaceURI, attribute.name, result.url);
    }
  }

  private shouldEnhance(href: string) {return !!this.profile && this.enhanceable.has(epubImageId(href));}

  private load(href: string, key: string, retry = false) {
    const result: Result = {key, controller: new AbortController(), processing: this.shouldEnhance(href)};
    this.results.set(href, result);
    this.onError(href);
    const signal = result.controller.signal;
    const show = async (blob: Blob) => {
      signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      try {
        await prepareReaderImage(url, signal); signal.throwIfAborted();
        const previous = result.url; result.url = url;
        this.apply(); if (previous) URL.revokeObjectURL(previous);
      } finally {if (result.url !== url) URL.revokeObjectURL(url);}
    };
    void (async () => {
      if (result.processing) {
        const blob = await enhanceImage(processingInput(key, this.owner, this.pages.get(epubImageId(href))?.blobKey), this.profile!, signal, {retry, onParent: show, onState: state => {
          if (!signal.aborted && state.phase !== 'ready') this.setEnhancementState(result, state);
        }});
        await show(blob); this.setEnhancementState(result, {phase: 'ready'});
      } else {
        const lease = await acquireImage(key, signal);
        try {await show(lease.blob);} finally {lease.release();}
      }
    })().catch(error => {
      if (!signal.aborted) {
        const message = (error as Error).message;
        if (result.processing) this.setEnhancementState(result, {phase: 'error', message});
        else this.onError(href, message);
      }
    });
  }

  private restore({element, attribute, original, width, height}: Artwork) {
    if (attribute.value !== original) element.setAttributeNS(attribute.namespaceURI, attribute.name, original);
    for (const [key, value] of [['width', width], ['height', height]] as const) {
      if (value === null) element.removeAttribute(key);
      else if (element.getAttribute(key) !== value) element.setAttribute(key, value);
    }
  }

  private setEnhancementState(result: Result, state?: ProcessingState) {
    if (result.enhancementState?.phase === state?.phase && result.enhancementState?.message === state?.message) return;
    result.enhancementState = state;
    this.onEnhancementChange();
  }

  enhancementState(href: string) {return this.results.get(href)?.enhancementState;}

  private release(href: string) {
    const result = this.results.get(href);
    if (!result) return;
    result.controller.abort();
    for (const artwork of this.artwork) if (artwork.href === href) this.restore(artwork);
    if (result.url) URL.revokeObjectURL(result.url);
    this.results.delete(href);
    if (result.enhancementState) this.onEnhancementChange();
  }

  retry(href: string) {
    const result = this.results.get(href);
    this.release(href);
    if (result) this.load(href, result.key, true); else this.apply();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.observer.disconnect();
    for (const document of new Set(this.artwork.map(value => value.element.ownerDocument))) document.removeEventListener('load', this.loaded, true);
    for (const href of this.results.keys()) this.release(href);
    this.artwork = [];
    this.byElement.clear();
    this.window = [];
    this.desired.clear();
    this.pages.clear();
  }
}
