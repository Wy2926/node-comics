import {zip} from 'wxt';
import {readFile} from 'node:fs/promises';
import {checkStorePackage} from './check-store-package.mjs';
const [browser, target, output] = process.argv.slice(2);
if (!['chrome', 'edge'].includes(browser) || !['download', 'store'].includes(target)) {
  throw new Error('Usage: node scripts/package-extension.mjs <chrome|edge> <download|store> [output-directory]');
}
process.env.NC_EXTENSION_PACKAGE = target;
const [archive] = await zip({browser, manifestVersion: 3, outDir: output ?? `.output/${target}`});
if (target === 'store') {
  const {version} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log('Store package verified:', await checkStorePackage(await readFile(archive), version));
}
