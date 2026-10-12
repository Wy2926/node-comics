import type Rendition from 'epubjs/types/rendition';
import type Contents from 'epubjs/types/contents';
import {acquireImage} from '../comics/application/image-access';
import {epubImageId} from '../comics/domain/epub-images';
import type {Page, Mode} from '../types';
import {readingImage} from './presentation';
import {prepareReaderImage} from './prepare-image';
import {enhanceImage} from '../image-processing/runtime';
import {activeProcessingProfile, processingIdentity, type ProcessingSettings} from '../image-processing/settings';
import type {ProcessingProfile, ProcessingState} from '../image-processing/contracts';

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
  release?: () => void;
  enhancement?: AbortController;
  enhancementState?: ProcessingState;
}

/** Only resource attributes change: no text nodes, wrappers, CFI tree or original blobs are replaced. */
export class EpubImageWindow {
  private artwork: Artwork[] = [];
  private byElement = new Map<Element, Artwork>();
  private window: string[] = [];
  private results = new Map<string, Result>();
  private desired = new Map<string, string>();
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
    for (let index = start; index >= 0 && index < this.artwork.length && selected.size < 4; index++) selected.add(this.artwork[index].href);
    const next = [...selected];
    if (JSON.stringify(next) !== JSON.stringify(this.window)) {
      this.window = next;
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
    this.enhanceable.clear();
    this.desired = new Map(pages.flatMap(page => {
      const result = readingImage(page, mode, translated, language, scope);
      if (result.key && (!translated || result.job)) this.enhanceable.add(page.id);
      return result.key && (result.job || this.profile && !translated) ? [[page.id, result.key]] : [];
    }));
    this.apply();
  }

  private apply() {
    if (this.closed) return;
    const wanted = new Map(this.window.flatMap(href => {
      const key = this.desired.get(epubImageId(href));
      return key ? [[href, key]] : [];
    }));
    for (const [href, result] of this.results) if (wanted.get(href) !== result.key) this.release(href);
    for (const [href, key] of wanted) {
      if (!this.results.has(href)) this.load(href, key);
      const result = this.results.get(href)!;
      if (!this.window.slice(0, 2).includes(href)) {
        result.enhancement?.abort(); result.enhancement = undefined;
        if (result.enhancementState?.phase === 'queued' || result.enhancementState?.phase === 'running') this.setEnhancementState(result);
      } else if (result.url && this.profile && this.enhanceable.has(epubImageId(href)) && !result.enhancement
        && result.enhancementState?.phase !== 'ready' && result.enhancementState?.phase !== 'error') {
        this.enhance(result);
      }
    }
    for (const artwork of this.artwork) {
      const result = this.results.get(artwork.href);
      if (!result?.url) {this.restore(artwork); continue;}
      const {element, attribute} = artwork;
      if (element.localName === 'img') {
        const img = element as HTMLImageElement;
        if (!img.complete || !img.naturalWidth) continue;
        // Keep the author's intrinsic image box when a channel delivers a smaller bitmap.
        if (artwork.width === null && artwork.height === null && attribute.value === artwork.original) {
          element.setAttribute('width', String(img.naturalWidth));
          element.setAttribute('height', String(img.naturalHeight));
        }
      }
      if (attribute.value !== result.url) element.setAttributeNS(attribute.namespaceURI, attribute.name, result.url);
    }
  }

  private load(href: string, key: string) {
    const result: Result = {key, controller: new AbortController()};
    this.results.set(href, result);
    this.onError(href);
    let url: string | undefined;
    void acquireImage(key, result.controller.signal).then(async lease => {
      result.release = lease.release;
      result.controller.signal.throwIfAborted();
      url = URL.createObjectURL(lease.blob);
      await prepareReaderImage(url, result.controller.signal);
      result.controller.signal.throwIfAborted();
      result.url = url;
      this.apply();
    }).catch(error => {
      if (url && result.url !== url) URL.revokeObjectURL(url);
      if (!result.controller.signal.aborted) {
        const message = (error as Error).message;
        if (this.profile) this.setEnhancementState(result, {phase: 'error', message});
        else this.onError(href, message);
      }
    }).finally(() => result.release?.());
  }

  private restore({element, attribute, original, width, height}: Artwork) {
    if (attribute.value !== original) element.setAttributeNS(attribute.namespaceURI, attribute.name, original);
    for (const [key, value] of [['width', width], ['height', height]] as const) {
      if (value === null) element.removeAttribute(key);
      else if (element.getAttribute(key) !== value) element.setAttribute(key, value);
    }
  }

  private enhance(result: Result, retry = false) {
    if (!this.profile) return;
    const controller = result.enhancement = new AbortController(), profile = this.profile;
    const signal = AbortSignal.any([controller.signal, result.controller.signal]);
    let release: (() => void) | undefined, url: string | undefined;
    this.setEnhancementState(result, {phase: 'queued'});
    void acquireImage(result.key, signal).then(async lease => {
      release = lease.release;
      const blob = await enhanceImage({blob: lease.blob, key: result.key, owner: this.owner}, profile, signal, state => {
        // A service result is ready for display only after its bitmap has decoded.
        if (!signal.aborted && state.phase !== 'ready') this.setEnhancementState(result, state);
      }, retry);
      signal.throwIfAborted();
      url = URL.createObjectURL(blob);
      await prepareReaderImage(url, signal);
      signal.throwIfAborted();
      const previous = result.url;
      result.url = url;
      this.setEnhancementState(result, {phase: 'ready'});
      this.apply();
      if (previous) URL.revokeObjectURL(previous);
    }).catch(error => {
      if (url && result.url !== url) URL.revokeObjectURL(url);
      if (!signal.aborted) this.setEnhancementState(result, {phase: 'error', message: (error as Error).message});
    }).finally(() => {
      release?.();
      if (result.enhancement === controller) result.enhancement = undefined;
    });
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
    result.enhancement?.abort();
    for (const artwork of this.artwork) if (artwork.href === href) this.restore(artwork);
    if (result.url) URL.revokeObjectURL(result.url);
    result.release?.();
    this.results.delete(href);
    if (result.enhancementState) this.onEnhancementChange();
  }

  retry(href: string) {
    const result = this.results.get(href);
    if (result?.url && this.profile && this.enhanceable.has(epubImageId(href))) {
      result.enhancement?.abort(); this.enhance(result, true);
    } else {this.release(href); this.apply();}
  }

  close() {
    this.closed = true;
    this.observer.disconnect();
    for (const document of new Set(this.artwork.map(value => value.element.ownerDocument))) document.removeEventListener('load', this.loaded, true);
    for (const href of this.results.keys()) this.release(href);
    this.artwork = [];
    this.byElement.clear();
    this.window = [];
    this.desired.clear();
  }
}
