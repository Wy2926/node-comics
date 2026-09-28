import type { AnalyticsEventName, AnalyticsFields, AnalyticsParams } from '../analytics';

type Reporter = <N extends AnalyticsEventName>(name: N, params: AnalyticsParams<N>, startedAt?: number) => void;
export type ReadingDimensions = Pick<AnalyticsFields, 'source_type' | 'format' | 'layout' | 'mode' | 'target_language'>;
type TranslationDimensions = Pick<AnalyticsFields, 'channel' | 'mode' | 'target_language'>;
const bounded = (value: number, max = 86400000) => Math.min(max, Math.max(0, Math.round(value)));
/** Keys exist only in this reader's memory. The reporter receives counts and categories. */
export class ReaderAnalytics {
  private enabled = false;
  private startedAt = 0;
  private consentedAt?: number;
  private opened = false;
  private engaged = false;
  private pages = new Set<string>();
  private pendingPages = 0;
  private activeMs = 0;
  private pendingMs = 0;
  private lastTick = 0;
  private lastInteraction = 0;
  private visible = false;
  private dimensions?: ReadingDimensions;
  private translations = new Set<string>();
  private requestedAt = new Map<string, number>();
  private quotaModes = new Set<string>();

  constructor(private readonly report: Reporter) { }

  setEnabled(enabled: boolean, at: number, consentedAt?: number) {
    if (this.enabled === enabled && this.consentedAt === consentedAt)
      return;
    this.enabled = enabled;
    this.consentedAt = consentedAt;
    this.startedAt = enabled ? Date.now() : 0;
    this.opened = false;
    this.engaged = false;
    this.pages.clear();
    this.pendingPages = 0;
    this.activeMs = 0;
    this.pendingMs = 0;
    this.lastTick = at;
    this.lastInteraction = at;
    this.visible = false;
    this.dimensions = undefined;
    this.translations.clear();
    this.requestedAt.clear();
    this.quotaModes.clear();
  }

  private advance(at: number) {
    if (this.enabled && this.visible) {
      // Visibility listeners handle normal transitions; cap timer suspension gaps.
      const elapsed = Math.max(0, Math.min(5000, at - this.lastTick, this.lastInteraction + 120000 - this.lastTick));
      this.activeMs += elapsed;
      this.pendingMs += elapsed;
    }
    this.lastTick = at;
  }

  interact(at: number) {
    this.advance(at);
    this.lastInteraction = at;
  }

  sample(at: number, visiblePages: readonly string[], dimensions: ReadingDimensions, visible: boolean, pageCount: number) {
    if (!this.enabled)
      return;
    this.advance(at);
    this.visible = visible && visiblePages.length > 0;
    if (this.dimensions && JSON.stringify(this.dimensions) !== JSON.stringify(dimensions))
      this.flush(at);
    this.dimensions = dimensions;
    if (!this.visible)
      return;
    if (!this.opened) {
      this.opened = true;
      this.report('reader_open', {
        surface: 'reader',
        ...dimensions,
        page_count: bounded(pageCount, 10000)
      }, this.startedAt);
    }
    for (const key of visiblePages)
      if (this.pages.size < 10000 && !this.pages.has(key)) {
        this.pages.add(key);
        this.pendingPages++;
      }
    if (!this.engaged && this.activeMs >= 60000 && this.pages.size >= 2) {
      this.engaged = true;
      this.report('reading_engaged', {
        surface: 'reader',
        ...dimensions,
        pages_viewed: this.pages.size,
        active_ms: bounded(this.activeMs)
      }, this.startedAt);
    }
  }

  flush(at: number) {
    if (!this.enabled)
      return;
    this.advance(at);
    if (this.dimensions && (this.pendingPages || this.pendingMs >= 1))
      this.report('reading_summary', {
        surface: 'reader',
        ...this.dimensions,
        pages_viewed: this.pendingPages,
        active_ms: bounded(this.pendingMs),
        engagement_time_msec: bounded(this.pendingMs),
      }, this.startedAt);
    this.pendingPages = 0;
    this.pendingMs = 0;
  }

  suspend(at: number) {
    this.flush(at);
    this.visible = false;
  }

  requestTranslation(at: number, dimensions: TranslationDimensions) {
    if (!this.enabled)
      return;
    const key = JSON.stringify(dimensions);
    this.requestedAt.set(key, at);
    this.translations.delete(key);
    this.report('translation_requested', {
      surface: 'reader',
      ...dimensions,
      method: 'manual'
    }, this.startedAt);
  }

  translationShown(at: number, dimensions: TranslationDimensions) {
    if (!this.enabled)
      return;
    const key = JSON.stringify(dimensions);
    if (this.translations.has(key))
      return;
    this.translations.add(key);
    const requested = this.requestedAt.get(key);
    this.report('translation_viewed', {
      surface: 'reader',
      ...dimensions,
      ...(requested === undefined ? {} : { duration_ms: bounded(at - requested) })
    }, this.startedAt);
  }

  quotaShown(dimensions: TranslationDimensions) {
    if (!this.enabled)
      return;
    const key = JSON.stringify(dimensions);
    if (this.quotaModes.has(key))
      return;
    this.quotaModes.add(key);
    this.report('quota_blocked', {
      surface: 'reader',
      mode: dimensions.mode,
      channel: dimensions.channel
    }, this.startedAt);
  }
}
