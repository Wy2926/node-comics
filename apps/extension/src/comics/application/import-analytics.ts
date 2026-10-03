import { track, type AnalyticsFields } from '../../analytics';

export function importFormat(name: string): AnalyticsFields['format'] {
  const suffix = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return suffix === 'cbz' || suffix === 'zip' || suffix === 'cbr' || suffix === 'rar' || suffix === 'pdf' || suffix === 'mobi' || suffix === 'epub' ? suffix : 'unknown';
}
/** Only the operation boundary is measured; file names, URLs and results never leave this function. */
export async function observeImport<T>(source_type: AnalyticsFields['source_type'], format: AnalyticsFields['format'], work: () => Promise<T>, created?: (result: T) => boolean): Promise<T> {
  const started = performance.now(), startedAt = Date.now();
  track('import_started', {
    surface: 'reader',
    source_type,
    format,
    count: 1
  }, startedAt);
  try {
    const result = await work(), duplicate = created?.(result) === false;
    track('import_result', {
      surface: 'reader',
      source_type,
      format,
      count: 1,
      outcome: duplicate ? 'duplicate' : 'success',
      duration_ms: Math.min(86400000, Math.round(performance.now() - started))
    }, startedAt);
    return result;
  }
  catch (error) {
    track('import_result', {
      surface: 'reader',
      source_type,
      format,
      count: 1,
      outcome: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed',
      duration_ms: Math.min(86400000, Math.round(performance.now() - started)),
      error_code: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'unknown'
    }, startedAt);
    throw error;
  }
}
