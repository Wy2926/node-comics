import {hashFile} from '../importers/hash';
import {msg} from '../i18n/runtime';
import {requireHostAccess} from '../host-permissions';
import {startImageTransfer, interruptAbandonedTransfer} from '../image-transfer/client';
import {releaseTransferBytes} from '../image-transfer/receipts';
import {processingAdapter} from './registry';
import {activeProcessingProfile, readProcessingSettings} from './settings';
import {initializeProcessingCache, processingCache, readProcessingRecord, saveProcessingRecord, readServiceLane, saveServiceLane, settleServiceLane, type ProcessingRecord} from './storage';
import type {ProcessingInput, ProcessingProfile, ProcessingState} from './contracts';

export function processingError(code: string) {
  if (code === 'RESULT_MISSING') return msg('增强缓存已清理，请手动重试。');
  if (code === 'INVALID_IMAGE') return msg('增强服务未返回有效图片。');
  if (code === 'HTTP_413') return msg('图片超过增强服务限制，请调整服务配置。');
  if (code === 'INTERRUPTED') return msg('增强连接已中断，服务可能仍在处理。确认后可手动重试。');
  return msg('增强失败，保留当前图片。');
}
function fail(code: string): never {throw Object.assign(Error(processingError(code)), {code});}
// Blobs are immutable; sharing their digest avoids rereading the same reader-window bytes.
// Weak keys retain neither old pages nor their image bytes. A new Blob is always verified again.
const inputDigests = new WeakMap<Blob, Promise<string>>();
function inputDigest(blob: Blob) {
  let digest = inputDigests.get(blob);
  if (!digest) {
    digest = hashFile(blob); inputDigests.set(blob, digest);
    void digest.catch(() => {if (inputDigests.get(blob) === digest) inputDigests.delete(blob);});
  }
  return digest;
}
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
    if (blob) return blob;
    if (!retry) fail('RESULT_MISSING');
  }
  if (record?.state === 'failed' && !retry) fail(record.errorCode ?? 'INTERRUPTED');
}
/** Receipts and a persistent service lane bound work across tabs and worker restarts.
 * The input is an already-materialized full image. This module never translates or resizes it.
 */
export async function enhanceImage(input: ProcessingInput, profile: ProcessingProfile, signal: AbortSignal,
  onState: (state: ProcessingState) => void = () => {}, retry = false): Promise<Blob> {
  signal.throwIfAborted();
  await initializeProcessingCache();
  const request = processingAdapter(profile.adapterId).request(profile.settings);
  const inputSha256 = await inputDigest(input.blob);
  const id = 'enhanced:' + await hashFile(new Blob([JSON.stringify([input.owner, input.key, inputSha256, profile.id, profile.revision, profile.settings])]));
  signal.throwIfAborted();
  const existing = await cached(await readProcessingRecord(id), retry);
  if (existing) {onState({phase: 'ready'}); return existing;}
  // Endpoint identity, not profile revision, controls concurrency. Changing model must not double it.
  const service = await hashFile(new Blob([request.url]));
  const run = async () => {
    signal.throwIfAborted();
    let record = await readProcessingRecord(id);
    const hit = await cached(record, retry);
    if (hit) {onState({phase: 'ready'}); return hit;}
    const lane = await readServiceLane(service);
    if (lane && !lane.settled && lane.requestId !== record?.requestId) {
      const previous = await settled(lane.requestId, signal);
      // A disconnected POST may still be running remotely. Require explicit confirmation
      // before admitting any further image to that endpoint, not just the original page.
      if ((!previous || previous.errorCode === 'INTERRUPTED') && !retry) fail('INTERRUPTED');
    }
    signal.throwIfAborted();
    if (!record || record.state !== 'running') {
      const selected = activeProcessingProfile(await readProcessingSettings());
      if (selected?.id !== profile.id || selected.revision !== profile.revision) throw new DOMException('Inactive enhancement', 'AbortError');
      await requireHostAccess([new URL(request.url).origin + '/*']);
      signal.throwIfAborted();
      record = {id, owner: input.owner, profileId: profile.id, inputSha256, requestId: crypto.randomUUID(), state: 'running', token: await processingCache.token(input.owner, id)};
      // Persist both identities before sending any private bytes. Recovery never invents a new UUID.
      await saveProcessingRecord(record);
      await saveServiceLane({id: service, requestId: record.requestId});
      await startImageTransfer(record.requestId, 'enhancement:' + service, input.blob, request);
    }
    const receipt = await settled(record.requestId, signal, onState);
    signal.throwIfAborted();
    await settleServiceLane(receipt);
    if (receipt?.state !== 'succeeded' || !receipt.output) {
      const errorCode = receipt?.errorCode ?? 'INTERRUPTED';
      await saveProcessingRecord({...record, state: 'failed', errorCode}); fail(errorCode);
    }
    const blob = receipt.output;
    const current = await processingCache.token(input.owner, id);
    if (current.epoch !== record.token.epoch || current.ownerGeneration !== record.token.ownerGeneration
      || (current.keyGeneration ?? 0) > (record.token.keyEpoch ?? 0)) {
      await releaseTransferBytes(record.requestId);
      await saveProcessingRecord({...record, state: 'failed', errorCode: 'RESULT_MISSING'}); fail('RESULT_MISSING');
    }
    await processingCache.put(id, blob, {owner: input.owner, connectionId: profile.id, token: record.token});
    await saveProcessingRecord({...record, state: 'succeeded'});
    await releaseTransferBytes(record.requestId);
    signal.throwIfAborted(); onState({phase: 'ready'}); return blob;
  };
  onState({phase: 'queued'});
  // Waiting requests carry only bounded reader-window inputs and are cancelled before admission.
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request('nc-enhancement-service:' + service, {signal}, run);
  return run();
}
