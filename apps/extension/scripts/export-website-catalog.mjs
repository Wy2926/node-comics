import assert from 'node:assert/strict';
import {mkdir, readFile, copyFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/export-website-catalog.mjs <output-directory>');
// A new directory avoids leaving retired icons in a release snapshot.
await mkdir(output);
const server = await createServer({configFile: false, root, server: {middlewareMode: true}, appType: 'custom'});
try {
  const {listSupportedSites} = await server.ssrLoadModule('/src/sources/registry/sites.ts');
  const sites = listSupportedSites();
  assert.ok(sites.length);
  assert.equal(new Set(sites.map(site => site.key)).size, sites.length);
  await mkdir(path.join(output, 'site-icons'));
  for (const icon of new Set(sites.map(site => site.icon).filter(icon => icon.startsWith('/site-icons/')))) {
    assert.match(icon, /^\/site-icons\/[a-z0-9-]+\.svg$/);
    await copyFile(path.join(root, 'public', icon), path.join(output, icon));
  }
  const {version} = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const config = await readFile(path.join(root, 'wxt.config.ts'), 'utf8');
  const permissions = config.match(/host_permissions:\s*(\[[^\]]*\])/);
  assert.ok(permissions, 'Missing host permission declaration');
  await writeFile(path.join(output, 'catalog.json'), JSON.stringify(sites, null, 2) + '\n');
  await writeFile(path.join(output, 'release.json'), JSON.stringify({version,
    host_permissions: JSON.parse(permissions[1].replaceAll("'", '"'))}, null, 2) + '\n');
  const types = await readFile(path.join(root, 'src/sources/contracts/definition.ts'), 'utf8');
  await writeFile(path.join(output, 'site-types.ts'), types.slice(types.indexOf('export type SourceSiteContentTag'), types.indexOf('/** Pure metadata')));
  await copyFile(path.join(root, 'src/analytics/schema.ts'), path.join(output, 'analytics-schema.ts'));
  console.log(`Exported ${sites.length} sites for extension ${version} to ${output}`);
} finally {
  await server.close();
}
