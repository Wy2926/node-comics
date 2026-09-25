import {parsePageReference} from '../../../comics/pages/identity';
import {hashFile} from '../../../importers/hash';
import {msg} from '../../../i18n/runtime';
import {pageTranslation} from '../../../reader/presentation';
import {LocalResultUnavailableError, saveResultBlob} from '../../../storage/translations/results';
import {translationCache} from '../../../storage/translations';
import type {Job, Mode} from '../../../types';
import {targetKey, type ReadingTarget, type TranslationState} from '../../automatic';
import type {ChannelRuntime, RuntimeOptions, TranslationScope} from '../contracts';
import {interruptAbandonedTransfer} from './client';
import {readDirectOperation, readDirectOperations, saveDirectOperation, updateDirectOperation, type DirectOperation} from './operations';
import {readTransferReceipt, releaseTransferBytes} from './receipts';
import {ImageTransferError, withTransferLock} from './types';

export interface DirectImageDriver {
  start(id: string, blob: Blob, mode: Mode, language: string): Promise<void>;
  errorMessage(code: string): string;
}

/** Reading-window scheduling and local receipts; no protocol, account or server task assumptions. */
export class DirectImageRuntime implements ChannelRuntime {
  private initialization?: Promise<void>;
  private records = new Map<string, DirectOperation>();
  private targets: ReadingTarget[] = [];
  private stopped = false;
  private pumping = false;
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  private runtimeError?: string;
  constructor(readonly scope: TranslationScope, private options: RuntimeOptions, private driver: DirectImageDriver) {}
  private current = () => !this.stopped && this.options.isCurrent();
  private id(target: ReadingTarget) {
    const image = target.page.imageSha256 ? ['sha256', target.page.imageSha256] : ['page', targetKey(target.entryId, target.page, target.mode)];
    return JSON.stringify([this.scope.key, this.options.language, target.mode, image]);
  }
  private needsStart(target: ReadingTarget) {
    return !this.records.has(this.id(target)) && !pageTranslation(target.page, target.mode, this.options.language, this.scope.key).latest;
  }
  get waitingIds() {return [...this.records.values()].filter(r => r.job.status === 'running').map(r => r.job.id);}
  get hasPending() {return this.waitingIds.length > 0 || this.targets.some(t => this.needsStart(t));}
  get retryDelay() {return 0;}
  private changed() {
    if (!this.current()) return;
    this.options.onChange();
    for (const listener of this.listeners) listener();
  }
  async init() {
    return this.initialization ??= (async () => {
      for (const record of await readDirectOperations(this.scope.key)) this.records.set(record.id, record);
      await this.reconcile(true);
      if (this.current()) await this.options.onJobs([...this.records.values()].flatMap(r => r.previousResult ? [r.previousResult, r.job] : [r.job]));
      this.schedule();
    })();
  }
  private async publish(record: DirectOperation) {
    const saved = await updateDirectOperation(record); this.records.set(saved.id, saved);
    if (this.current()) await this.options.onJobs([saved.job]);
    this.changed();
  }
  private async adopt(record: DirectOperation) {
    const previous = this.records.get(record.id);
    this.records.set(record.id, record);
    if (previous?.job.id !== record.job.id || previous.job.status !== record.job.status || previous.job.updated_at !== record.job.updated_at) {
      if (this.current()) await this.options.onJobs([record.job]);
      this.changed();
    }
  }
  private failure(record: DirectOperation, code: string): DirectOperation {
    return {...record, job: {...record.job, status: 'failed', phase: 'failed', updated_at: new Date().toISOString(),
      error: {code, message: this.driver.errorMessage(code)}, result_available: false}};
  }
  private async reconcile(recover = false) {
    const saved = await readDirectOperations(this.scope.key);
    for (const savedRecord of saved) {
      if (savedRecord.job.status !== 'running') {await this.adopt(savedRecord); continue;}
      await withTransferLock('settle:' + savedRecord.job.id, async () => {
      const record = await readDirectOperation(savedRecord.id);
      if (!record) return;
      await this.adopt(record);
      if (record.job.status !== 'running') return;
      const receipt = recover ? await interruptAbandonedTransfer(record.job.id) : await readTransferReceipt(record.job.id);
      if (!receipt) {
        // Another tab may still be preparing bytes under the operation lock.
        const locks = typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.query() : undefined;
        if (locks?.held?.some(lock => lock.name === 'nc-image-transfer:operation:' + record.id)) return;
        await this.publish(this.failure(record, 'INTERRUPTED')); return;
      }
      if (receipt.state === 'failed') {await this.publish(this.failure(record, receipt.errorCode ?? 'INTERRUPTED')); return;}
      if (receipt.state !== 'succeeded') return;
      const job: Job = {...record.job, status: 'succeeded', phase: 'succeeded', completed_at: new Date(receipt.updatedAt).toISOString(),
        updated_at: new Date(receipt.updatedAt).toISOString(), result: {key: record.job.id, recoverable: false}, result_available: true};
      if (receipt.output) {
        // Finishing an old channel is safe: the immutable scope prevents it updating another channel.
        try {
          if (!record.cacheToken) throw new LocalResultUnavailableError();
          await saveResultBlob({scope: this.scope, job, blob: receipt.output, cacheToken: record.cacheToken, isCurrent: () => true});
          await this.publish({...record, job});
        } catch (error) {
          if (!(error instanceof LocalResultUnavailableError)) throw error;
          await this.publish(this.failure(record, error.code));
        }
        await releaseTransferBytes(record.job.id);
      } else await this.publish(this.failure(record, 'RESULT_MISSING'));
      });
    }
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.current() || !this.waitingIds.length) return;
    this.timer = setTimeout(() => {
      void this.reconcile(true).then(() => this.pump()).catch(() => {}).finally(() => this.schedule());
    }, 750);
  }
  async submit(targets: ReadingTarget[], isCurrent = () => true) {
    await this.init();
    if (!this.current() || !isCurrent()) return;
    // Only the unstarted tail is replaced. An already submitted image retains its receipt.
    this.targets = targets.slice(0, 4); this.runtimeError = undefined;
    void this.pump();
  }
  private async pump() {
    if (this.pumping || !this.current()) return;
    this.pumping = true;
    let canContinue = true;
    try {
      await this.reconcile();
      if (this.waitingIds.length) {this.schedule(); return;}
      const target = this.targets.find(value => this.needsStart(value));
      if (!target) return;
      const id = this.id(target);
      await withTransferLock('admission:' + this.scope.key, () => withTransferLock('operation:' + id, async () => {
        if (!this.current() || !this.targets.some(t => this.id(t) === id)) return;
        await this.reconcile();
        if (this.waitingIds.length) return;
        const existing = await readDirectOperation(id);
        if (existing) {this.records.set(id, existing); return;}
        const displayed = pageTranslation(target.page, target.mode, this.options.language, this.scope.key);
        if (displayed.latest) return;
        await this.begin(target);
      }));
    } catch {
      canContinue = false; this.runtimeError = this.driver.errorMessage('INTERRUPTED'); this.changed();
    } finally {
      this.pumping = false; this.schedule();
      if (canContinue && this.current() && !this.waitingIds.length && this.targets.some(value => this.needsStart(value))) void this.pump();
    }
  }
  private async begin(target: ReadingTarget, previous?: DirectOperation) {
    const created = new Date().toISOString();
    let record: DirectOperation = {
      id: this.id(target), scope: this.scope.key, entryId: target.entryId, pageId: target.page.id,
      previousResult: previous?.job.status === 'succeeded' ? previous.job : previous?.previousResult,
      job: {id: crypto.randomUUID(), input_asset_id: null, output_asset_id: null, image_sha256: target.page.imageSha256,
        mode: target.mode, target_language: this.options.language, status: 'running', phase: 'translating_text',
        created_at: created, updated_at: created, version: 1, quota_pages: 0, cache_hit: false},
    };
    await saveDirectOperation(record); this.records.set(record.id, record);
    if (this.current()) await this.options.onJobs([record.job]);
    this.changed();
    let lease: {blob: Blob; release: () => void} | undefined;
    try {
      // Capture before source acquisition/network work; cache clearing fences late completion.
      record = {...record, cacheToken: await translationCache.token(this.scope.key)};
      const reference = target.page.blobKey ? parsePageReference(target.page.blobKey) : undefined;
      if (reference) lease = await this.options.readOriginal?.(reference);
      const blob = lease?.blob ?? (target.page.blobKey ? await this.options.getBlob(target.page.blobKey) : undefined);
      if (!blob) throw new ImageTransferError('SOURCE_MISSING');
      const sha = await hashFile(blob);
      if (target.page.imageSha256 && sha !== target.page.imageSha256 || target.page.imageByteSize && blob.size !== target.page.imageByteSize)
        throw new ImageTransferError('SOURCE_CHANGED');
      if (!this.current()) throw new ImageTransferError('INTERRUPTED');
      record = {...record, job: {...record.job, image_sha256: sha}};
      await this.publish(record);
      await this.driver.start(record.job.id, blob, target.mode, this.options.language);
      if (target.page.blobKey) await this.options.onInputConsumed?.(target.page.blobKey).catch(() => {});
    } catch (error) {
      await this.publish(this.failure(record, error instanceof ImageTransferError ? error.code : 'INTERRUPTED'));
    } finally {lease?.release();}
  }
  async manual(target: ReadingTarget) {
    await this.init();
    if (!this.current()) return;
    const id = this.id(target);
    await withTransferLock('admission:' + this.scope.key, () => withTransferLock('operation:' + id, async () => {
      await this.reconcile(true);
      const previous = await readDirectOperation(id);
      if (previous?.job.status === 'running') throw Error(msg('原请求结果待核实，暂不能重复翻译。'));
      if (this.waitingIds.length) throw Error(msg('请等待当前翻译完成后重试。'));
      await this.begin(target, previous);
    }));
    this.schedule();
  }
  async wait(signal: AbortSignal) {
    await this.init(); signal.throwIfAborted();
    if (!this.hasPending) return false;
    await new Promise<void>((resolve, reject) => {
      const done = () => {clearTimeout(timer); this.listeners.delete(done); signal.removeEventListener('abort', abort); resolve();};
      const abort = () => {clearTimeout(timer); this.listeners.delete(done); reject(signal.reason);};
      const timer = setTimeout(done, 1000);
      this.listeners.add(done); signal.addEventListener('abort', abort, {once: true});
    });
    await this.reconcile(true); void this.pump(); return this.hasPending;
  }
  stateFor(target: ReadingTarget, active: boolean, error?: string): TranslationState | undefined {
    const displayed = pageTranslation(target.page, target.mode, this.options.language, this.scope.key);
    const record = this.records.get(this.id(target));
    if (record?.job.status === 'running') return {kind: 'translating', message: msg('翻译中')};
    if (record?.job.status === 'failed') return {kind: 'error', message: record.job.error?.message ?? msg('翻译失败'), retryable: true, retryAction: 'translate'};
    const failure = error || target.page.translationError || this.runtimeError;
    if (failure) return {kind: 'error', message: failure, retryable: true, retryAction: 'translate'};
    if (displayed.ready) return;
    if (displayed.expired) return {kind: 'error', message: this.driver.errorMessage('RESULT_MISSING'), retryable: true, retryAction: 'translate'};
    if (record?.job.status === 'succeeded') return {kind: 'waiting', message: msg('正在加载译图…')};
    if (active) return {kind: 'waiting', message: msg('等待翻译')};
    return undefined;
  }
  async refresh() {await this.init(); await this.reconcile(true); this.changed(); void this.pump();}
  dispose() {this.stopped = true; clearTimeout(this.timer); this.targets = []; for (const listener of this.listeners) listener(); this.listeners.clear();}
}
