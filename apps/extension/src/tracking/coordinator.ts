import {aniListProvider, TrackingError} from './anilist';
import type {AniListProvider, TrackingRemoteEntry} from './anilist';
import {getTrackingCredential} from './auth';
import type {TrackingCredential} from './auth';
import {readTrackingSession, trackingStore} from './store';
import {trackingScope} from './model';
import type {TrackingJob} from './model';

type Provider = Pick<AniListProvider, 'media' | 'save'>;
/** One instance in the background is the sole network writer; IDB owns durable recovery. */
export class TrackingCoordinator {
  private running?: Promise<boolean>;
  constructor(private provider: Provider = aniListProvider, private credential = getTrackingCredential, private now = Date.now) {}
  runNext(): Promise<boolean> {
    return this.running ??= this.perform().finally(() => {this.running = undefined;});
  }
  private async currentCredential(job: TrackingJob): Promise<TrackingCredential | undefined> {
    const credential = await this.credential();
    if (!credential || credential.accountId !== job.accountId || credential.epoch !== job.epoch || credential.expiresAt <= this.now()) return;
    return credential;
  }
  private async perform(): Promise<boolean> {
    const session = await readTrackingSession();
    if (!session.enabled || !session.accountId || !session.epoch) return false;
    const job = await trackingStore.next(trackingScope(session.accountId, session.epoch), this.now()); if (!job) return false;
    try {
      const credential = await this.currentCredential(job);
      if (!credential) throw new TrackingError('auth');
      const media = await this.provider.media(job.mediaId, credential.token), remote = media.entry;
      if (media.id !== job.mediaId || remote && (remote.mediaId !== job.mediaId || remote.userId !== job.accountId)) throw new TrackingError('identity');
      if (!await trackingStore.current(job) || !await this.currentCredential(job)) return true;
      const reason = !remote && job.baseline ? 'remote-deleted'
        : remote && job.baseline && (remote.id !== job.baseline.listEntryId || remote.progress < job.baseline.progress) ? 'remote-reset'
        : remote && !['CURRENT', 'PLANNING'].includes(remote.status) ? 'protected-state'
        : media.chapters !== null && media.chapters > 0 && job.progress > media.chapters ? 'total-mismatch' : undefined;
      if (reason) {await trackingStore.fail(job, reason); return true;}
      if (remote && remote.progress >= job.progress) {await this.confirm(job, remote); return true;}
      // A fresh credential/session check fences disconnect, account change and rebind during GET.
      const current = await this.currentCredential(job);
      if (!current || !await trackingStore.current(job)) return true;
      const result = await this.provider.save({mediaId: job.mediaId, listEntryId: remote?.id, progress: job.progress,
        ...(!remote || remote.status === 'PLANNING' ? {status: 'CURRENT' as const} : {})}, current.token);
      await this.confirm(job, result);
    } catch (error) {
      const code = error instanceof TrackingError ? error.code : 'unavailable';
      const retryable = code === 'rate-limit' || code === 'unavailable';
      const retryAt = retryable && job.attempts < 5
        ? Math.max(this.now() + Math.min(900_000, 15_000 * 2 ** job.attempts), error instanceof TrackingError ? error.retryAt ?? 0 : 0) : undefined;
      await trackingStore.fail(job, retryable && retryAt === undefined ? 'retry-exhausted' : code, retryAt);
    }
    return true;
  }
  private async confirm(job: TrackingJob, remote: TrackingRemoteEntry) {
    if (remote.mediaId !== job.mediaId || remote.userId !== job.accountId || remote.progress < job.progress) throw new TrackingError('identity');
    await trackingStore.acknowledge(job, {listEntryId: remote.id, progress: remote.progress}, this.now());
  }
}
