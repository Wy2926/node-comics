import {zip} from 'wxt';
const [browser, target, output] = process.argv.slice(2);
if (!['chrome', 'edge'].includes(browser) || !['download', 'store'].includes(target)) {
  throw new Error('Usage: node scripts/package-extension.mjs <chrome|edge> <download|store> [output-directory]');
}
process.env.NC_EXTENSION_PACKAGE = target;
await zip({browser, manifestVersion: 3, outDir: output ?? `.output/${target}`});
