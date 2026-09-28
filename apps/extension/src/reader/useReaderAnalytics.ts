import { useEffect, useRef, type RefObject } from 'react';
import { track, type AnalyticsFields } from '../analytics';
import { useAnalyticsPreferences } from '../analytics/consent';
import type { ShownImage } from './Images';
import { ReaderAnalytics, type ReadingDimensions } from './analytics';

interface Options {
  session?: ReaderAnalytics;
  viewport: RefObject<HTMLDivElement | null>;
  cells: RefObject<Map<string, HTMLDivElement>>;
  actual: Record<string, ShownImage | undefined>;
  dimensions: ReadingDimensions;
  channel?: AnalyticsFields['channel'];
  pageCount: number;
  blocked: boolean;
  quotaBlocked: boolean;
}
export function useReaderAnalytics(options: Options) {
  const fallback = useRef<ReaderAnalytics | undefined>(undefined);
  const session = options.session ?? (fallback.current ??= new ReaderAnalytics(track));
  const {enabled, consentedAt} = useAnalyticsPreferences();
  const current = useRef(options);
  current.current = options;
  useEffect(() => {
    const now = () => performance.now();
    session.setEnabled(enabled, now(), consentedAt);
    if (!enabled)
      return;
    const sample = () => {
      const value = current.current, view = value.viewport.current, at = now();
      const foreground = !document.hidden && document.hasFocus() && !value.blocked;
      const keys: string[] = [], translated: ShownImage[] = [];
      if (foreground && view) {
        const bounds = view.getBoundingClientRect();
        for (const [key, cell] of value.cells.current) {
          const image = value.actual[key];
          if (!image)
            continue;
          const rect = cell.getBoundingClientRect();
          const height = Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top);
          const width = Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left);
          // Decoded adjacent/preloaded pages do not count until visibly in the viewport.
          if (height <= 0 || width <= 0 || height < Math.min(rect.height, bounds.height) * 0.25)
            continue;
          keys.push(key);
          if (image.job)
            translated.push(image);
        }
      }
      session.sample(at, keys, value.dimensions, foreground, value.pageCount);
      if (value.channel)
        for (const image of translated)
          session.translationShown(at, {
            channel: value.channel,
            mode: image.job!.mode,
            target_language: image.job!.target_language as AnalyticsFields['target_language']
          });
      if (value.channel && keys.length && value.quotaBlocked)
        session.quotaShown({
          channel: value.channel,
          mode: value.dimensions.mode,
          target_language: value.dimensions.target_language
        });
    };
    const interact = () => {
      session.interact(now());
      sample();
    };
    const visibility = () => {
      sample();
      if (document.hidden || !document.hasFocus())
        session.suspend(now());
    };
    const flush = () => {
      sample();
      session.suspend(now());
    };
    const timer = setInterval(sample, 1000), summary = setInterval(() => {
      sample();
      session.flush(now());
    }, 30000);
    const view = current.current.viewport.current;
    view?.addEventListener('scroll', sample, { passive: true });
    for (const event of ['pointerdown', 'wheel', 'keydown', 'touchstart'])
      window.addEventListener(event, interact, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', visibility);
    window.addEventListener('focus', visibility);
    window.addEventListener('pagehide', flush);
    sample();
    return () => {
      session.suspend(now());
      clearInterval(timer);
      clearInterval(summary);
      view?.removeEventListener('scroll', sample);
      for (const event of ['pointerdown', 'wheel', 'keydown', 'touchstart'])
        window.removeEventListener(event, interact);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', visibility);
      window.removeEventListener('focus', visibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [session, enabled, consentedAt, !!options.viewport.current]);
  return session;
}
