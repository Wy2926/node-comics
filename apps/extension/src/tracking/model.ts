/** Non-secret tracker records. Source credentials and OAuth tokens never enter the catalog. */
export interface TrackingSession {
  id: 'tracking-session'; accountId?: number; name?: string; epoch?: string; enabled: boolean;
  [key: string]: unknown;
}
export interface TrackingBinding {
  id: string; sourceKey: string; sourceGeneration: number;
  mediaId: number; title: string; offset: number; paused: boolean; revision: string;
  issue?: string;
}
export interface TrackingContribution {comicId: string; bindingRevision: string; progress: number}
export interface TrackingJob {
  id: string; scope: string; accountId: number; epoch: string; mediaId: number;
  revision: number; contributions: TrackingContribution[]; progress: number;
  status: 'pending' | 'syncing' | 'synced' | 'blocked'; reason?: string;
  attempts: number; nextRunAt: number; updatedAt: number;
  baseline?: {listEntryId: number; progress: number};
  /** Explicit user acceptance of a reset invalidates every earlier in-flight receipt. */
  baselineResetRevision?: number;
}
export interface CompletionIdentity {contentId: string; generation: number}
export const TRACKING_SESSION = 'tracking-session';
export const TRACKING_IDLE = Number.MAX_SAFE_INTEGER;
export const trackingScope = (accountId: number, epoch: string) => JSON.stringify([accountId, epoch]);
export const trackingJobId = (scope: string, mediaId: number) => `${scope}:${mediaId}`;
/** Native labels only; no rounding, title parsing, release counting or implicit first chapter. */
export function chapterProgress(label: string | undefined, offset: number): number | undefined {
  if (!label || !/^\d+$/.test(label) || !Number.isSafeInteger(offset)) return;
  const chapter = Number(label), progress = chapter + offset;
  if (chapter < 1 || !Number.isSafeInteger(chapter) || !Number.isSafeInteger(progress) || progress < 1 || progress > 2_147_483_647) return;
  return progress;
}
