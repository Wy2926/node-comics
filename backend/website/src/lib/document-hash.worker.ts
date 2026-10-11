import { hashDocumentBlob } from './document-hash';

self.onmessage = async ({ data }: MessageEvent<Blob>) => {
  try {
    const sha256 = await hashDocumentBlob(data, bytes => self.postMessage({ bytes }));
    self.postMessage({ sha256 });
  } catch { self.postMessage({ error: 'DOCUMENT_HASH_FAILED' }); }
};
