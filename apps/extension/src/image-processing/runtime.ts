import {hashFile} from '../importers/hash';
import {msg} from '../i18n/runtime';
import {requireHostAccess} from '../host-permissions';
import {startImageTransfer, interruptAbandonedTransfer} from '../image-transfer/client';
import {readTransferReceipt,releaseTransferBytes} from '../image-transfer/receipts';
import {processingAdapter} from './registry';
import {activeProcessingProfile, readProcessingSettings} from './settings';
import {initializeProcessingCache, processingCache, findProcessingRecord, saveProcessingRecord, readServiceLane, saveServiceLane,
  finalizeProcessingReceipt, processingTokenCurrent, type ProcessingRecord} from './storage';
import type {ProcessingInput, ProcessingProfile, ProcessingState} from './contracts';

function processingError(code: string) {
  if (code === 'RESULT_MISSING') return msg('增强缓存已清理，请手动重试。');
  if (code === 'INVALID_IMAGE') return msg('增强服务未返回有效图片。');
  if (code === 'HTTP_413') return msg('图片超过增强服务限制，请调整服务配置。');
  if (code === 'INTERRUPTED') return msg('增强连接已中断，服务可能仍在处理。确认后可手动重试。');
  return msg('增强失败，保留当前图片。');
}
function fail(code: string): never {throw Object.assign(Error(processingError(code)), {code});}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {clearTimeout(timer); reject(signal.reason);};
    const timer = setTimeout(() => {signal.removeEventListener('abort', abort); resolve();}, 200);
    signal.addEventListener('abort', abort, {once: true});
  });
}
async function settled(requestId: string, signal: AbortSignal, notify?: (state: ProcessingState) => void) {
  let previousPhase: ProcessingState['phase'] | undefined;
  for (;;) {
    signal.throwIfAborted();
    const receipt = await interruptAbandonedTransfer(requestId);
    signal.throwIfAborted();
    if (!receipt || receipt.state === 'succeeded' || receipt.state === 'failed') return receipt;
    const phase = receipt.state === 'running' ? 'running' : 'queued';
    if (phase !== previousPhase) {notify?.({phase}); previousPhase = phase;}
    await pause(signal);
  }
}
async function cached(record: ProcessingRecord | undefined, retry: boolean) {
  if (record?.state === 'succeeded') {
    const blob = await processingCache.get(record.id);
    if (await processingTokenCurrent(record)) {
      if (blob) return blob;
      const delivery = await readTransferReceipt(record.requestId);
      if (delivery?.state === 'succeeded' && delivery.output) {
        await releaseTransferBytes(record.requestId);
        if (await processingTokenCurrent(record)) return delivery.output;
      }
    }
    if (!retry) fail('RESULT_MISSING');
  }
  if (record?.state === 'failed' && !retry) fail(record.errorCode ?? 'INTERRUPTED');
}
interface Options {
  onState?: (state: ProcessingState) => void;
  onParent?: (blob: Blob) => void | Promise<void>;
  retry?: boolean;
}
/** Metadata first. Only a new, admitted request reads/hashes the complete parent image.
 * Accepted work is finalized by its execution host even when this caller leaves.
 */
export async function enhanceImage(input: ProcessingInput, profile: ProcessingProfile, signal: AbortSignal, options: Options = {}): Promise<Blob> {
  const {onState = () => {}, onParent, retry = false} = options;
  let parent: Awaited<ReturnType<ProcessingInput['load']>> | undefined;
  const validate = async () => {signal.throwIfAborted(); await input.validate(); signal.throwIfAborted();};
  const selected = async () => {
    const active = activeProcessingProfile(await readProcessingSettings());
    if (active?.id !== profile.id || active.revision !== profile.revision) throw new DOMException('Inactive enhancement', 'AbortError');
    signal.throwIfAborted();
  };
  const load = async () => {
    if (!parent) {
      await validate();
      parent = await input.load(signal);
      await validate();
      await onParent?.(parent.blob);
    }
    return parent.blob;
  };
  try {
    await validate();
    await initializeProcessingCache();
    const lookupKey = await hashFile(new Blob([JSON.stringify([input.owner, input.key, profile.id, profile.revision])]), undefined, signal);
    const ready = async (blob: Blob) => {await validate(); onState({phase: 'ready'}); return blob;};
    const existing = await cached(await findProcessingRecord(lookupKey), retry);
    if (existing) return await ready(existing);
    const request = processingAdapter(profile.adapterId).request(profile.settings);
    // Endpoint identity, not profile revision, bounds concurrency across tabs.
    const service = await hashFile(new Blob([request.url]), undefined, signal);
    const run = async () => {
      await validate();
      let record = await findProcessingRecord(lookupKey);
      const hit = await cached(record, retry);
      if (hit) return ready(hit);
      const lane = await readServiceLane(service);
      if (lane && !lane.settled && lane.requestId !== record?.requestId) {
        const previous = await settled(lane.requestId, signal);
        if (previous) await finalizeProcessingReceipt(previous);
        // A disconnected POST may still be running remotely. Never silently replay it.
        if ((!previous || previous.errorCode === 'INTERRUPTED') && !retry) fail('INTERRUPTED');
      }
      if (!record || record.state !== 'running') {
        await selected();
        await requireHostAccess([new URL(request.url).origin + '/*']);
        const blob = await load();
        const inputSha256 = await hashFile(blob, undefined, signal);
        const id = 'enhanced:' + await hashFile(new Blob([JSON.stringify([lookupKey, inputSha256])]), undefined, signal);
        await validate(); await selected();
        record = {id, lookupKey, owner: input.owner, profileId: profile.id, requestId: crypto.randomUUID(), state: 'running', token: await processingCache.token(input.owner, id)};
        await saveProcessingRecord(record);
        await saveServiceLane({id: service, requestId: record.requestId});
        await startImageTransfer(record.requestId, 'enhancement:' + service, blob, request);
      }
      const receipt = await settled(record.requestId, signal, onState);
      if (receipt) await finalizeProcessingReceipt(receipt);
      else await saveProcessingRecord({...record, state: 'failed', errorCode: 'INTERRUPTED'});
      signal.throwIfAborted();
      const result = await cached(await findProcessingRecord(lookupKey), false);
      if (!result) fail('INTERRUPTED');
      return ready(result);
    };
    onState({phase: 'queued'});
    return await (typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('nc-enhancement-service:' + service, {signal}, run) : run());
  } catch (error) {
    // Fallback is lazy too. It cannot hide the enhancement error or submit anything.
    if (!signal.aborted && (error as Error).name !== 'AbortError' && onParent && !parent) await load().catch(() => {});
    throw error;
  } finally {parent?.release();}
}
