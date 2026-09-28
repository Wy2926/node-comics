import type { AnalyticsEventName, AnalyticsFields, AnalyticsParams } from '../analytics';

type Reporter = <N extends AnalyticsEventName>(name: N, params: AnalyticsParams<N>, startedAt?: number) => void;
interface InlineAnalyticsContext {
  channel?: AnalyticsFields['channel'];
  mode: AnalyticsFields['mode'];
  language: string;
}
/** One observation per explicit start/configuration, never per page or polling response. */
export class InlineAnalytics {
  private started = false;
  private startedAt = 0;
  private consentedAt?: number;
  private requested = false;
  private viewed = false;
  private automatic = false;

  constructor(private readonly report: Reporter) { }

  setConsent(enabled: boolean, consentedAt?: number) {
    const next = enabled && Number.isSafeInteger(consentedAt) ? consentedAt : undefined;
    if (next === this.consentedAt) return;
    this.consentedAt = next;
    this.requested = false;
    this.viewed = false;
    if (next !== undefined) this.startedAt = Math.max(this.startedAt, next);
  }

  start(automatic: boolean) {
    this.started = true;
    this.startedAt = Date.now();
    this.automatic = automatic;
    this.requested = false;
    this.viewed = false;
  }

  stop() {
    this.started = false;
    this.requested = false;
    this.viewed = false;
  }

  private dimensions(context: InlineAnalyticsContext) {
    return {
      surface: 'inline' as const,
      channel: context.channel,
      mode: context.mode,
      target_language: context.language as AnalyticsFields['target_language'],
      method: this.automatic ? 'automatic' as const : 'manual' as const
    };
  }

  accepted(context: InlineAnalyticsContext, observedAt = Date.now()) {
    if (!this.started || this.consentedAt === undefined || observedAt < this.startedAt || this.requested || !context.channel)
      return;
    this.requested = true;
    this.report('translation_requested', this.dimensions(context), this.startedAt);
  }

  shown(context: InlineAnalyticsContext) {
    if (!this.started || this.consentedAt === undefined || !this.requested || this.viewed || !context.channel)
      return;
    this.viewed = true;
    this.report('translation_viewed', this.dimensions(context), this.startedAt);
  }
}
