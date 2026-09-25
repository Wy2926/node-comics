/** A request recipe exists only in trusted extension memory; never persist headers or URLs. */
export interface ImageTransferRequest {
  url: string;
  headers: Record<string, string>;
  imageField: string;
  fields: Record<string, string>;
  maxBytes: number;
  maxPixels: number;
  maxDimension: number;
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

export const transferLock = (id: string) => 'nc-image-transfer:' + id;
export async function withTransferLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request(transferLock(id), action) : action();
}
