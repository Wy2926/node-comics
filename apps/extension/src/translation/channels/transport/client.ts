import {executeImageTransfer} from './execute';
import {readTransferReceipt, saveTransferReceipt, trimTransferReceipts} from './receipts';
import {ImageTransferError, transferLock, withTransferLock, type ImageTransferRequest} from './types';

export const HOST_MESSAGE = 'NC_CHANNEL_IMAGE_HOST';
const hostPage = '/translation-host.html';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hasExtension = () => typeof chrome !== 'undefined' && !!chrome.runtime?.id;
async function requiresHost() {
  if (!hasExtension()) return false;
  if (typeof document === 'undefined') return true;
  // Firefox event backgrounds also have a document. Only a real extension tab owns a durable page.
  // getCurrent() is undefined in both background pages and popups; neither should hold a long fetch.
  try {return (await chrome.tabs.getCurrent())?.id === undefined;}
  catch {return true;}
}
async function pingHost() {
  return chrome.runtime.sendMessage({type: HOST_MESSAGE, action: 'ping'}).then(reply => reply?.ready === true).catch(() => false);
}
async function ensureHost() {
  const ensure = async () => {
    if (await pingHost()) return;
    await chrome.tabs.create({url: chrome.runtime.getURL(hostPage), active: false});
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await pingHost()) return;
      await pause(100);
    }
    throw new ImageTransferError('HOST_UNAVAILABLE');
  };
  await withTransferLock('host-creation', ensure);
}

/** Starts quickly. Credentials are passed in trusted messaging, never written to IndexedDB. */
export async function startImageTransfer(id: string, scope: string, input: Blob, request: ImageTransferRequest) {
  // Do not wait behind the execution lock of a receipt already accepted by another context.
  if (await readTransferReceipt(id)) return;
  await withTransferLock('launch:' + id, async () => {
    const created = await withTransferLock(id, async () => {
      if (await readTransferReceipt(id)) return false;
      await trimTransferReceipts();
      await saveTransferReceipt({id, scope, state: 'prepared', input, updatedAt: Date.now()});
      return true;
    });
    if (!created) return;
    try {
      if (!await requiresHost()) {
        await new Promise<void>((resolve, reject) => {
          void executeImageTransfer(id, request, resolve).then(resolve, reject);
        });
      } else {
        await ensureHost();
        // A lost response does not authorize a retry. Recovery only observes the durable receipt.
        const reply = await chrome.runtime.sendMessage({type: HOST_MESSAGE, action: 'start', id, request});
        if (reply?.accepted !== true) throw new ImageTransferError('HOST_UNAVAILABLE');
      }
    } catch {
      // Recovery runs after this launch lock is released; a slow startup must not appear abandoned.
    }
  });
  await interruptAbandonedTransfer(id);
}

/** Web Locks survive SW restarts while their owning extension page is alive. */
export async function interruptAbandonedTransfer(id: string) {
  const receipt = await readTransferReceipt(id);
  if (!receipt || !['prepared', 'running'].includes(receipt.state)) return receipt;
  if (typeof navigator !== 'undefined' && navigator.locks) {
    // Match the launch -> execution lock order. A query snapshot can become stale before the
    // execution lock is acquired; holding both locks makes the abandonment decision atomic.
    return navigator.locks.request(transferLock('launch:' + id), {ifAvailable: true}, async launch => {
      if (!launch) return readTransferReceipt(id);
      return navigator.locks.request(transferLock(id), {ifAvailable: true}, async execution => {
        if (!execution) return readTransferReceipt(id);
        const current = await readTransferReceipt(id);
        if (current && ['prepared', 'running'].includes(current.state)) {
          const failed = {...current, state: 'failed' as const, input: undefined, errorCode: 'INTERRUPTED', updatedAt: Date.now()};
          await saveTransferReceipt(failed); return failed;
        }
        return current;
      });
    });
  }
  // All supported extension browsers have Web Locks. Non-extension tests keep live execution local.
  return receipt;
}
