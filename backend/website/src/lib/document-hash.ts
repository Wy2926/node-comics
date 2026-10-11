import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const HASH_CHUNK_BYTES = 2 * 1024 * 1024;

/** Runs in a dedicated worker; never holds the entire source file in memory. */
export async function hashDocumentBlob(file: Blob, progress: (bytes: number) => void = () => {}) {
  const hash = sha256.create();
  try {
    for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
      const end = Math.min(file.size, offset + HASH_CHUNK_BYTES);
      hash.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
      progress(end);
    }
    return bytesToHex(hash.digest());
  } finally { hash.destroy(); }
}
