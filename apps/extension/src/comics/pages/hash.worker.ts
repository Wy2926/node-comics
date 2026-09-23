import {Sha256} from '../../importers/hash';
self.onmessage = async (event: MessageEvent<Blob>) => {
  try {
    const hash = new Sha256(), blob = event.data;
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024)
      hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
    self.postMessage({sha256: hash.digest()});
  } catch (error) { self.postMessage({error: (error as Error).message}); }
};
