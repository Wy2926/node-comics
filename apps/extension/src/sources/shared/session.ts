import { SourceError } from '../contracts/diagnostics';
import type { SourcePageContext, SourcePageSession } from '../contracts/page';
import type { SourceSnapshot } from '../contracts/source';
import { observeImages } from './observe';
export function imageSession(
  context: SourcePageContext,
  options: {
    snapshot: () => SourceSnapshot;
    read?: () => Promise<SourceSnapshot>;
    targets: SourcePageSession['inlineTargets'];
    attributes?: string[];
    containers?: string;
  },
): SourcePageSession {
  let disposed = false;
  const cleanups = new Set<() => void>();
  const active = () => {
    context.signal.throwIfAborted();
    if (disposed) throw Error('SOURCE_SESSION_EXPIRED');
  };
  return {
    direction: 'rtl',
    snapshot() {
      active();
      return options.snapshot();
    },
    async discoverPages() {
      active();
      if (context.location.kind !== 'reader') return { status: 'unsupported', code: 'UNSUPPORTED_PAGE' };
      try {
        const value = await (options.read?.() ?? options.snapshot());
        active();
        return value.items.length
          ? { status: 'ready', value }
          : { status: 'not-ready', code: 'WAITING_FOR_IMAGES', partial: value };
      } catch (error) {
        active();
        return {
          status: 'error',
          code: error instanceof SourceError ? error.code : 'SOURCE_DISCOVERY_FAILED',
        };
      }
    },
    inlineTargets() {
      active();
      return context.location.kind === 'reader' ? options.targets() : [];
    },
    observe(changed) {
      active();
      const cleanup = observeImages(context.document, changed, options.attributes, options.containers);
      cleanups.add(cleanup);
      return () => {
        cleanup();
        cleanups.delete(cleanup);
      };
    },
    dispose() {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
    },
  };
}
