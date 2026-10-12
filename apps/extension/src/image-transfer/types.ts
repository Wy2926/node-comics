/** Protocol-neutral recipe, kept only in trusted extension memory; no persisted URLs or headers. */
export interface ImageTransferRequest {
  url: string;
  headers: Record<string, string>;
  imageField: string;
  fields: Record<string, string>;
}

export interface ImageTransferReceipt {
  id: string;
  scope: string;
  state: 'prepared' | 'running' | 'succeeded' | 'failed';
  updatedAt: number;
  input?: Blob;
  output?: Blob;
  errorCode?: string;
}

export class ImageTransferError extends Error {
  constructor(readonly code: string) { super(code); }
}

const finalizers = new Set<(receipt: ImageTransferReceipt) => Promise<void>>();
/** Consumers publish durable results in the execution context, not in a departing UI. */
export function registerTransferFinalizer(finalize: (receipt: ImageTransferReceipt) => Promise<void>) {
  finalizers.add(finalize);
}
export async function finalizeImageTransfer(receipt: ImageTransferReceipt) {
  await Promise.all([...finalizers].map(finalize => finalize(receipt)));
}

export const transferLock = (id: string) => 'nc-image-transfer:' + id;
export async function withTransferLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request(transferLock(id), action) : action();
}
