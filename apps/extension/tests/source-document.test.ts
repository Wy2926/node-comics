import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceDefinition } from '../src/sources/contracts/definition';
import type { CreateSourcePage } from '../src/sources/contracts/page';
import { SourceDocument } from '../src/sources/core/document';
import { SourceNavigation } from '../src/sources/core/navigation';
import { imageSession } from '../src/sources/shared/session';

function fixture() {
  vi.useFakeTimers();
  const view = Object.assign(new EventTarget(), {
    location: { href: 'https://fixture.test/one' },
    setInterval: vi.fn((callback: () => void, delay: number) => setInterval(callback, delay)),
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
  });
  const definition: SourceDefinition = {
    id: 'generic',
    name: '',
    installation: { requiredOrigins: [], autoContentMatches: [] },
    capabilities: { pages: true, inline: true, catalog: false, completePageList: false },
    identify: (url) => ({ sourceId: 'generic', pageKey: url.href, url: url.href, kind: 'reader' }),
  };
  const observe = vi.fn(() => vi.fn()),
    dispose = vi.fn();
  const factory: CreateSourcePage = () => ({
    direction: 'rtl',
    snapshot: vi.fn(),
    discoverPages: vi.fn(),
    inlineTargets: () => [],
    observe,
    dispose,
  });
  const lifecycle = new SourceDocument(
    view as unknown as Window,
    (invalidate) => new SourceNavigation({} as Document, [definition], { generic: factory }, invalidate),
  );
  return { view, lifecycle, observe, dispose };
}

afterEach(() => vi.useRealTimers());

describe('shared document lifecycle', () => {
  it('shares one observer and timer, retaining the session until the final consumer leaves', () => {
    const { view, lifecycle, observe, dispose } = fixture();
    const identity = lifecycle.current();
    const first = lifecycle.subscribe({ changed: vi.fn(), invalidated: vi.fn() });
    const second = lifecycle.subscribe({ changed: vi.fn(), invalidated: vi.fn() });
    expect(lifecycle.current()).toBe(identity);
    expect(observe).toHaveBeenCalledOnce();
    expect(view.setInterval).toHaveBeenCalledOnce();
    first();
    expect(dispose).not.toHaveBeenCalled();
    second();
    expect(dispose).toHaveBeenCalledOnce();
    expect(identity.controller.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('invalidates cached-page resources and restores its subscribers and SPA polling on pageshow', async () => {
    const { view, lifecycle, observe } = fixture();
    const changed = vi.fn(),
      invalidated = vi.fn();
    const release = lifecycle.subscribe({ changed, invalidated });
    const original = lifecycle.current();
    view.dispatchEvent(new Event('pagehide'));
    expect(original.controller.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => lifecycle.current()).toThrow('SOURCE_SESSION_EXPIRED');
    view.dispatchEvent(new Event('pageshow'));
    const restored = lifecycle.current();
    expect(restored.navigationId).not.toBe(original.navigationId);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    changed.mockClear();
    view.location.href = 'https://fixture.test/two';
    await vi.advanceTimersByTimeAsync(250);
    expect(restored.controller.signal.aborted).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    expect(invalidated).toHaveBeenCalledTimes(2);
    release();
  });

  it('allows inline consumers to unsubscribe during invalidation without dropping the discovery consumer', () => {
    const { view, lifecycle, observe } = fixture();
    const releaseDiscovery = lifecycle.subscribe({ changed: vi.fn(), invalidated: vi.fn() });
    let releaseInline = () => {};
    releaseInline = lifecycle.subscribe({ changed: vi.fn(), invalidated: () => releaseInline() });
    view.location.href = 'https://fixture.test/two';
    view.dispatchEvent(new Event('popstate'));
    expect(lifecycle.current().url).toBe(view.location.href);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    releaseDiscovery();
  });

  it('redacts unexpected page exceptions at the discovery boundary', async () => {
    const session = imageSession(
      {
        document: {} as Document,
        location: { sourceId: 'generic', pageKey: 'one', url: 'https://fixture.test', kind: 'reader' },
        signal: new AbortController().signal,
      },
      {
        snapshot() {
          throw Error('private signed URL and page text');
        },
        targets: () => [],
      },
    );
    expect(await session.discoverPages()).toEqual({ status: 'error', code: 'SOURCE_DISCOVERY_FAILED' });
    session.dispose();
  });
});
