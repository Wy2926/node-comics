import {describe, expect, it} from 'vitest';
import {ZipWriter, Uint8ArrayWriter, TextReader} from '@zip.js/zip.js';
import {checkStorePackage} from '../scripts/check-store-package.mjs';

async function archive(extra = {}, manifest = {}) {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, content] of Object.entries({
    'manifest.json': JSON.stringify({manifest_version: 3, version: '0.11.3', ...manifest}),
    'import-assets/pdf/pdf.worker.mjs': 'module.exports = Object.create;\nclass WorkerMessageHandler {}',
    ...extra,
  })) await zip.add(name, new TextReader(content));
  return zip.close();
}

describe('final store archive guard', () => {
  it('accepts an MV3 store archive with the readable local worker', async () => {
    await expect(checkStorePackage(await archive(), '0.11.3')).resolves.toMatchObject({version: '0.11.3', scriptFiles: 1});
  });
  it.each(['ActiveXObject', 'NullProtoObject', 'document.F=Object'])('rejects %s in any bundled script', async code => {
    await expect(checkStorePackage(await archive({'chunks/pdf.js': code}), '0.11.3')).rejects.toThrow('Obsolete PDF fallback');
  });
  it('rejects copied pre-minified workers', async () => {
    await expect(checkStorePackage(await archive({'assets/pdf.worker.min-hash.mjs': 'var a=1;'}), '0.11.3')).rejects.toThrow('Pre-minified PDF worker');
  });
  it('rejects manual-install keys and wrong versions', async () => {
    await expect(checkStorePackage(await archive({}, {key: 'manual-install'}), '0.11.3')).rejects.toThrow('manifest.key');
    await expect(checkStorePackage(await archive(), '0.11.4')).rejects.toThrow('version differs');
  });
  it('rejects a worker without readable implementation names', async () => {
    await expect(checkStorePackage(await archive({'import-assets/pdf/pdf.worker.mjs': 'module.exports = Object.create; class a {}'}), '0.11.3')).rejects.toThrow('readable upstream names');
  });
});
