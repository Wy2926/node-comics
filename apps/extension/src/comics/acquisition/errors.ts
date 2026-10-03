import type { DownloadTask } from '../application/types';
import { ImagePermissionsRequired } from '../../sources';

// Queue policy is shared; provider-specific errors keep their own message and HTTP status.
export const downloadErrorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : '下载失败，请重试。').replace(/https?:\/\/\S+/g, '[来源地址]');

export function blockingReason(error: unknown): DownloadTask['reason'] {
  if (error instanceof ImagePermissionsRequired || (error as { kind?: string })?.kind === 'permission-required') return 'permission';
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'space';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'network';
  if (error instanceof Error && (error.name === 'TimeoutError' || error.cause instanceof TypeError) || error instanceof TypeError) return 'network';
  const details = (error as { details?: { status?: number; retryAfter?: number } })?.details;
  if (details?.status === 401 || details?.status === 403 || details?.status === 429 || details?.retryAfter) return 'source';
  return undefined;
}

export function downloadRetryAt(error: unknown): number | undefined {
  const details = (error as { details?: { status?: number; retryAfter?: number } })?.details;
  const seconds = details?.retryAfter ?? (details?.status === 429 ? 60 : 0);
  return seconds > 0 ? Date.now() + seconds * 1000 : undefined;
}
