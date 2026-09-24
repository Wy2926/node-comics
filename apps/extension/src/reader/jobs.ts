import type { Job, JobStatus } from '../types';
export const pendingStatuses: ReadonlySet<JobStatus> = new Set(['awaiting_upload', 'validating_upload', 'queued', 'running', 'outcome_unknown']);
const statusRank: Record<JobStatus, number> = {
  awaiting_upload: -2, validating_upload: -1, queued: 0, running: 1, outcome_unknown: 2, unknown_released:3, failed: 3, cancelled: 3, no_text: 3, succeeded: 4,
};
/** Late snapshots cannot regress a task or resurrect a deleted/expired result. */
export function mergeJobs(previous: Job[], incoming: Job[]): Job[] {
  const jobs = new Map(previous.map(job => [job.id, job]));
  for (const job of incoming) {
    const old = jobs.get(job.id);
    if (old && !job.result_expired && statusRank[job.status] < statusRank[old.status] && !(job.updated_at&&(!old.updated_at||job.updated_at>old.updated_at)))
      continue;
    const tombstone = old?.result_expired || old?.status === 'succeeded' && !old.output_asset_id;
    jobs.set(job.id, tombstone && job.output_asset_id
      ? { ...job, output_asset_id: null, result_available: false, result_expired: true }
      : job);
  }
  return [...jobs.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.version - b.version);
}
/** Request order, not completion order: late old workers cannot replace newer results. */
export function newestFirst(jobs: Job[]) {
  return [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.version - a.version || b.id.localeCompare(a.id));
}
