import {catalog, type CatalogMutation} from '../comics/repositories';
import type {CatalogTable} from '../comics/domain';
import {chapterProgress, TRACKING_IDLE, TRACKING_SESSION, trackingJobId, trackingScope} from './model';
import type {CompletionIdentity, TrackingBinding, TrackingJob, TrackingSession} from './model';

const tables: CatalogTable[] = ['trackingBindings', 'trackingJobs', 'metadata', 'comics', 'connections'];
const sessionIn = async (tx: CatalogMutation) => await tx.get('metadata', TRACKING_SESSION) as TrackingSession | undefined;
const active = (session: TrackingSession | undefined, scope: string) => !!session?.enabled && !!session.accountId && !!session.epoch && trackingScope(session.accountId, session.epoch) === scope;
export const readTrackingSession = async (): Promise<TrackingSession> => await catalog.get('metadata', TRACKING_SESSION) as TrackingSession ?? {id: TRACKING_SESSION, enabled: false};
export const writeTrackingSession = (session: TrackingSession) => catalog.put('metadata', session);

async function bindingValid(tx: CatalogMutation, binding: TrackingBinding) {
  const comic = await tx.get('comics', binding.id);
  if (!comic || comic.sourceKey !== binding.sourceKey || comic.source.generation !== binding.sourceGeneration || comic.source.status !== 'active') return false;
  const connection = await tx.get('connections', comic.source.connectionId);
  return !!connection && !['disconnected', 'revoked'].includes(connection.status);
}
async function validContributions(tx: CatalogMutation, job: TrackingJob) {
  const valid: TrackingJob['contributions'] = [];
  for (const contribution of job.contributions) {
    const binding = await tx.get('trackingBindings', contribution.comicId);
    if (binding && !binding.paused && binding.mediaId === job.mediaId && binding.revision === contribution.bindingRevision && await bindingValid(tx, binding)) valid.push(contribution);
  }
  return valid;
}
function withContributions(job: TrackingJob, contributions: TrackingJob['contributions'], now: number): TrackingJob {
  return {...job, contributions, progress: Math.max(0, ...contributions.map(c => c.progress)), revision: job.revision + 1,
    status: contributions.length ? 'pending' : 'synced', reason: undefined, attempts: 0,
    nextRunAt: contributions.length ? now : TRACKING_IDLE, updatedAt: now};
}
async function invalidateBinding(tx: CatalogMutation, binding: TrackingBinding, now: number) {
  const session = await sessionIn(tx);
  if (!session?.accountId || !session.epoch) return;
  const id = trackingJobId(trackingScope(session.accountId, session.epoch), binding.mediaId), job = await tx.get('trackingJobs', id);
  if (job) await tx.put('trackingJobs', withContributions(job, job.contributions.filter(c => c.comicId !== binding.id), now));
}

export const trackingStore = {
  async suggest(comicId: string, mediaId: number) {
    if (!Number.isSafeInteger(mediaId) || mediaId < 1 || mediaId > 2_147_483_647) return;
    await catalog.mutate(['comics', 'trackingBindings', 'metadata'], async tx => {
      if (!await tx.get('comics', comicId) || await tx.get('trackingBindings', comicId)) return;
      await tx.put('metadata', {id: 'tracking-candidate:' + comicId, mediaId});
    });
  },
  async suggestedMediaId(comicId: string): Promise<number | undefined> {
    const [source] = await catalog.list('catalogs', {index: 'comicId', range: comicId, limit: 1});
    const exact = (source?.externalIds as {anilist?: number} | undefined)?.anilist;
    const candidate = exact ?? (await catalog.get('metadata', 'tracking-candidate:' + comicId))?.mediaId;
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 && candidate <= 2_147_483_647 ? candidate : undefined;
  },
  binding: (comicId: string) => catalog.get('trackingBindings', comicId),
  job: (scope: string, mediaId: number) => catalog.get('trackingJobs', trackingJobId(scope, mediaId)),
  async bind(comicId: string, media: {id: number; title: string}, offset: number) {
    if (!Number.isSafeInteger(offset) || Math.abs(offset) > 100000) throw Error('Invalid chapter offset');
    await catalog.mutate(tables, async tx => {
      const comic = await tx.get('comics', comicId); if (!comic || comic.source.status !== 'active') throw Error('Source unavailable');
      const old = await tx.get('trackingBindings', comicId); if (old) await invalidateBinding(tx, old, Date.now());
      await tx.put('trackingBindings', {id: comicId, sourceKey: comic.sourceKey, sourceGeneration: comic.source.generation,
        mediaId: media.id, title: media.title, offset, revision: crypto.randomUUID(), paused: false});
    });
  },
  async unbind(comicId: string) {
    await catalog.mutate(tables, async tx => {
      const binding = await tx.get('trackingBindings', comicId); if (!binding) return;
      await invalidateBinding(tx, binding, Date.now()); await tx.remove('trackingBindings', comicId);
    });
  },
  async pause(comicId: string, paused: boolean) {
    await catalog.mutate(tables, async tx => {
      const binding = await tx.get('trackingBindings', comicId); if (!binding) return;
      await invalidateBinding(tx, binding, Date.now());
      await tx.put('trackingBindings', {...binding, paused, issue: undefined, revision: crypto.randomUUID()});
    });
  },
  /** Completion and intent commit together, including rereads whose readAt was already saved. */
  async complete(entryId: string, identity: CompletionIdentity, now = Date.now()) {
    return catalog.mutate([...tables, 'entries'], async tx => {
      const entry = await tx.get('entries', entryId);
      if (!entry || entry.contentId !== identity.contentId || entry.generation !== identity.generation || entry.indexState !== 'ready' || !entry.discoveryComplete || !entry.pageCount || entry.knownTotal && entry.knownTotal !== entry.pageCount || entry.error || entry.sourceRemoved) return;
      const comic = await tx.get('comics', entry.comicId); if (!comic || comic.source.status !== 'active') return;
      if (!entry.readAt) await tx.put('entries', {...entry, readAt: now});
      const session = await sessionIn(tx), binding = await tx.get('trackingBindings', entry.comicId);
      if (!session?.enabled || !session.accountId || !session.epoch || !binding || binding.paused || !await bindingValid(tx, binding)) return;
      const progress = chapterProgress(entry.chapterNumber, binding.offset);
      if (progress === undefined) {await tx.put('trackingBindings', {...binding, issue: 'chapter-mapping'}); return;}
      if (binding.issue) await tx.put('trackingBindings', {...binding, issue: undefined});
      const scope = trackingScope(session.accountId, session.epoch), id = trackingJobId(scope, binding.mediaId);
      const job = await tx.get('trackingJobs', id), contributions = job ? await validContributions(tx, job) : [];
      const previous = contributions.find(c => c.comicId === comic.id);
      if (previous && previous.progress >= progress) return;
      const contribution = {comicId: comic.id, bindingRevision: binding.revision, progress};
      if (previous) Object.assign(previous, contribution); else contributions.push(contribution);
      // Completion never silently clears a protected/reset/auth error; only explicit retry does.
      const blocked = job?.status === 'blocked';
      await tx.put('trackingJobs', {id, scope, accountId: session.accountId, epoch: session.epoch, mediaId: binding.mediaId,
        revision: (job?.revision ?? 0) + 1, contributions, progress: Math.max(...contributions.map(c => c.progress)),
        status: blocked ? 'blocked' : 'pending', reason: blocked ? job.reason : undefined, attempts: blocked ? job.attempts : 0,
        nextRunAt: blocked ? TRACKING_IDLE : now, updatedAt: now, baseline: job?.baseline, baselineResetRevision: job?.baselineResetRevision});
      return !blocked;
    });
  },
  async next(scope: string, now = Date.now()): Promise<TrackingJob | undefined> {
    return catalog.mutate(tables, async tx => {
      if (!active(await sessionIn(tx), scope)) return;
      const [job] = await tx.list('trackingJobs', {index: 'due', range: IDBKeyRange.bound([scope, 0], [scope, now]), limit: 1});
      if (!job) return;
      const contributions = await validContributions(tx, job);
      if (!contributions.length) {await tx.put('trackingJobs', withContributions(job, [], now)); return;}
      const next: TrackingJob = {...job, revision: job.revision + 1, contributions, progress: Math.max(...contributions.map(c => c.progress)), status: 'syncing', nextRunAt: now + 90_000};
      await tx.put('trackingJobs', next); return next;
    });
  },
  /** Revalidate immediately before network write; deletion/rebinding wins over old captured work. */
  async current(job: TrackingJob): Promise<boolean> {
    return catalog.mutate(tables, async tx => {
      const live = await tx.get('trackingJobs', job.id);
      if (!active(await sessionIn(tx), job.scope) || live?.revision !== job.revision) return false;
      const valid = await validContributions(tx, live);
      if (JSON.stringify(valid) === JSON.stringify(job.contributions)) return true;
      await tx.put('trackingJobs', withContributions(live, valid, Date.now())); return false;
    });
  },
  async acknowledge(job: TrackingJob, baseline: NonNullable<TrackingJob['baseline']>, now = Date.now()) {
    await catalog.mutate(tables, async tx => {
      const live = await tx.get('trackingJobs', job.id); if (!live || !active(await sessionIn(tx), job.scope)) return;
      if (job.revision < (live.baselineResetRevision ?? 0)) return;
      // A late receipt may advance this account's baseline, never clear a newer intent.
      const same = live.revision === job.revision;
      const accepted = live.baseline && ((!same && live.baseline.listEntryId !== baseline.listEntryId) || live.baseline.listEntryId === baseline.listEntryId && live.baseline.progress >= baseline.progress) ? live.baseline : baseline;
      await tx.put('trackingJobs', {...live, baseline: accepted, status: same ? 'synced' : live.status,
        nextRunAt: same ? TRACKING_IDLE : live.nextRunAt, attempts: same ? 0 : live.attempts,
        reason: same ? undefined : live.reason, updatedAt: now});
    });
  },
  async fail(job: TrackingJob, reason: string, retryAt?: number) {
    await catalog.mutate(['trackingJobs'], async tx => {
      const live = await tx.get('trackingJobs', job.id); if (!live || live.revision !== job.revision) return;
      await tx.put('trackingJobs', {...live, status: retryAt === undefined ? 'blocked' : 'pending', reason,
        attempts: live.attempts + 1, nextRunAt: retryAt ?? TRACKING_IDLE, updatedAt: Date.now()});
    });
  },
  async retry(scope: string, mediaId: number) {
    await catalog.mutate(['trackingJobs'], async tx => {
      const job = await tx.get('trackingJobs', trackingJobId(scope, mediaId)); if (!job) return;
      await tx.put('trackingJobs', {...job, revision: job.revision + 1, status: 'pending', reason: undefined, attempts: 0, nextRunAt: Date.now()});
    });
  },
  async resetBaseline(job: TrackingJob, baseline?: TrackingJob['baseline']) {
    await catalog.mutate(['trackingJobs'], async tx => {
      const live = await tx.get('trackingJobs', job.id); if (!live || live.revision !== job.revision) throw Error('Tracking changed; retry confirmation');
      await tx.put('trackingJobs', {...withContributions(live, [], Date.now()), baseline, baselineResetRevision: live.revision + 1});
    });
  },
  async nextRunAt(scope: string) {
    const [job] = await catalog.list('trackingJobs', {index: 'due', range: IDBKeyRange.bound([scope, 0], [scope, TRACKING_IDLE - 1]), limit: 1});
    return job?.nextRunAt;
  },
  async discardScope(scope: string) {
    for (;;) {
      const count = await catalog.mutate(['trackingJobs'], async tx => {
        const jobs = await tx.list('trackingJobs', {index: 'scope', range: scope, limit: 100});
        for (const job of jobs) await tx.remove('trackingJobs', job.id); return jobs.length;
      });
      if (count < 100) return;
    }
  },
  async resumeAuthorization(scope: string) {
    for (;;) {
      const count = await catalog.mutate(['trackingJobs'], async tx => {
        const jobs = await tx.list('trackingJobs', {index: 'blocked', range: [scope, 'blocked', 'auth'], limit: 100});
        for (const job of jobs) await tx.put('trackingJobs', {...job, revision: job.revision + 1, status: 'pending', reason: undefined, attempts: 0, nextRunAt: Date.now()});
        return jobs.length;
      });
      if (count < 100) return;
    }
  },
};
