import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareReaderImage } from '../src/reader/prepare-image';

class FakeImage extends EventTarget {
  static instances: FakeImage[] = [];
  static onSource: ((image: FakeImage) => void) | undefined;
  readonly decoding = Promise.withResolvers<void>();
  readonly decode = vi.fn(() => this.decoding.promise);
  readonly sources: string[] = [];
  readonly subscriptions = new Map<string, Set<EventListenerOrEventListenerObject>>();
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  private source = '';

  constructor() { super(); FakeImage.instances.push(this); }
  get src() { return this.source; }
  set src(value: string) { this.source = value; this.sources.push(value); FakeImage.onSource?.(this); }
  removeAttribute = vi.fn((name: string) => { if (name === 'src') this.source = ''; });
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) {
      const listeners = this.subscriptions.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(listener); this.subscriptions.set(type, listeners);
    }
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener) this.subscriptions.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  load(width = 4000, height = 6000) {
    this.complete = true; this.naturalWidth = width; this.naturalHeight = height;
    this.dispatchEvent(new Event('load'));
  }
  fail() {
    this.complete = true; this.naturalWidth = 0; this.naturalHeight = 0;
    this.dispatchEvent(new Event('error'));
  }
}

const source = 'blob:https://reader.test/original';
const encodingError = () => new DOMException('Decode cache exhausted', 'EncodingError');
function start(controller = new AbortController()) {
  const ready = prepareReaderImage(source, controller.signal);
  const image = FakeImage.instances.at(-1)!;
  const settled = vi.fn();
  void ready.then(settled, settled);
  return { ready, image, settled, controller };
}
function expectReleasedListeners(image: FakeImage) {
  expect(image.subscriptions.get('load')?.size ?? 0).toBe(0);
  expect(image.subscriptions.get('error')?.size ?? 0).toBe(0);
}

beforeEach(() => {
  FakeImage.instances = []; FakeImage.onSource = undefined;
  vi.stubGlobal('Image', FakeImage);
});
afterEach(() => vi.unstubAllGlobals());

describe('reader image preparation', () => {
  it('waits for successful predecode even after native loading finishes', async () => {
    const { ready, image, settled, controller } = start();
    image.load(); await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    image.decoding.resolve(); await ready;
    expect(settled).toHaveBeenCalledOnce();
    expect(image.decode).toHaveBeenCalledOnce(); expectReleasedListeners(image);
    controller.abort();
    expect(image.src).toBe(source);
    expect(image.removeAttribute).not.toHaveBeenCalled();
  });

  it('uses a native load that finished before decode rejected', async () => {
    const { ready, image } = start();
    image.load(); image.decoding.reject(encodingError());
    await expect(ready).resolves.toBeUndefined();
    expect(FakeImage.instances).toHaveLength(1); expect(image.sources).toEqual([source]);
    expectReleasedListeners(image);
  });

  it('waits for native load after decode rejects without starting another image request', async () => {
    const { ready, image, settled } = start();
    image.decoding.reject(encodingError()); await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(FakeImage.instances).toHaveLength(1); expect(image.sources).toEqual([source]);
    image.load(); await expect(ready).resolves.toBeUndefined();
    expectReleasedListeners(image);
  });

  it('does not lose a cached load emitted when the source is assigned', async () => {
    FakeImage.onSource = image => image.load();
    const { ready, image } = start();
    image.decoding.reject(encodingError());
    await expect(ready).resolves.toBeUndefined();
    expectReleasedListeners(image);
  });

  it('accepts an already complete valid image when no load event remains to observe', async () => {
    const { ready, image } = start();
    image.complete = true; image.naturalWidth = 4000; image.naturalHeight = 6000;
    image.decoding.reject(encodingError());
    await expect(ready).resolves.toBeUndefined();
    expectReleasedListeners(image);
  });

  it.each(['before', 'after'] as const)('rejects native image errors %s decode rejects', async order => {
    const { ready, image, settled } = start();
    const rejected = expect(ready).rejects.toMatchObject({ name: 'EncodingError' });
    if (order === 'after') { image.decoding.reject(encodingError()); await Promise.resolve(); }
    image.fail(); await rejected;
    if (order === 'before') image.decoding.reject(encodingError());
    image.load(); await Promise.resolve();
    expect(settled).toHaveBeenCalledOnce(); expectReleasedListeners(image);
  });

  it('preserves non-EncodingError failures even when native loading succeeded', async () => {
    const { ready, image } = start();
    const error = new DOMException('Request was replaced', 'AbortError');
    image.load(); image.decoding.reject(error);
    await expect(ready).rejects.toBe(error);
    expectReleasedListeners(image);
  });

  it.each([[0, 6000], [4000, 0]])('rejects a fallback image with dimensions %i × %i', async (width, height) => {
    const { ready, image } = start();
    image.decoding.reject(encodingError()); await Promise.resolve();
    image.load(width, height);
    await expect(ready).rejects.toMatchObject({ name: 'EncodingError' });
    expectReleasedListeners(image);
  });

  it('does not mark a zero-sized image ready even if decode resolves', async () => {
    const { ready, image } = start();
    image.decoding.resolve();
    await expect(ready).rejects.toMatchObject({ name: 'EncodingError' });
    expectReleasedListeners(image);
  });

  it.each(['predecode', 'fallback'] as const)('cancels during %s and ignores late image events', async phase => {
    const { ready, image, settled, controller } = start();
    if (phase === 'fallback') { image.decoding.reject(encodingError()); await Promise.resolve(); }
    const reason = new DOMException('Page changed', 'AbortError');
    controller.abort(reason);
    await expect(ready).rejects.toBe(reason);
    expect(image.src).toBe(''); expect(image.removeAttribute).toHaveBeenCalledExactlyOnceWith('src');
    expectReleasedListeners(image);
    image.load(); image.fail(); image.decoding.resolve(); await Promise.resolve();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('does not start loading after the page request was already cancelled', () => {
    const controller = new AbortController();
    const reason = new DOMException('Page changed', 'AbortError'); controller.abort(reason);
    expect(() => prepareReaderImage(source, controller.signal)).toThrow(reason);
    expect(FakeImage.instances).toHaveLength(0);
  });
});
