import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;
const script = fileURLToPath(new URL('../scripts/check-modules.mjs', import.meta.url));
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'nc-module-check-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'entrypoints'));
  writeFileSync(path.join(root, 'tsconfig.json'), '{}');
});
afterEach(() => {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('nc-module-check-')) throw Error('Unexpected fixture directory');
  rmSync(root, {recursive: true});
});
const source = (name: string, code: string) => {mkdirSync(path.dirname(path.join(root,name)),{recursive:true});writeFileSync(path.join(root, name), code);};
const run = () => spawnSync(process.execPath, [script, root], {encoding: 'utf8'});

describe('module boundary check', () => {
  it.each(["import '../sites/b/page';","export * from '../sites/b/page';","import('../sites/b/page');"])('rejects direct core site dependencies: %s',code=>{
    source('entrypoints/main.ts',"import '../src/sources/core/resolve';");source('src/sources/core/resolve.ts',code);source('src/sources/sites/b/page.ts','export const value=1;');
    expect(run().stderr).toContain('Source boundary');
  });
  it('rejects cross-site imports and adapter application dependencies',()=>{
    source('entrypoints/main.ts',"import '../src/sources/registry/pages';");source('src/sources/registry/pages.ts',"import '../sites/a/page';");
    source('src/sources/sites/a/page.ts',"import '../b/page';");source('src/sources/sites/b/page.ts',"import '../../../library/store';");source('src/library/store.ts','export {};');
    const result=run();expect(result.stderr).toContain('same site');expect(result.stderr).toContain('adapter depends on application');
  });
  it('rejects transitive DOM code in definitions even inside an uncalled function',()=>{
    source('entrypoints/main.ts',"import '../src/sources/registry/definitions';");source('src/sources/registry/definitions.ts',"export * from '../sites/a/definition';");
    source('src/sources/sites/a/definition.ts',"export * from './helper';");source('src/sources/sites/a/helper.ts',"export const unsafe=()=>window.location.href;");
    expect(run().stderr).toContain('Source definition uses page/browser global');
  });
  it('allows definitions and DOM factories in separate registries',()=>{
    source('entrypoints/main.ts',"import '../src/sources/registry/definitions';import '../src/sources/registry/pages';");
    source('src/sources/registry/definitions.ts',"export * from '../sites/a/definition';");source('src/sources/registry/pages.ts',"export * from '../sites/a/page';");
    source('src/sources/sites/a/definition.ts',"export const id='a';");source('src/sources/sites/a/page.ts','export const page=()=>document.title;');
    expect(run().status).toBe(0);
  });
  it('rejects a runtime cycle through a shared component', () => {
    source('entrypoints/main.ts', "import '../src/app';");
    source('src/app.ts', "import './modal';");
    source('src/modal.ts', "import './app';");
    const result = run();
    expect(result.status).toBe(1);expect(result.stderr).toContain('Runtime import cycle');
  });
  it('allows type-only cycles and follows lazy imports and Vite worker queries', () => {
    source('entrypoints/main.ts', "import type {A} from '../src/a'; import('../src/lazy'); import Worker from '../src/worker?worker';");
    source('src/a.ts', "import type {B} from './b'; export interface A {b:B}");
    source('src/b.ts', "import type {A} from './a'; export interface B {a:A}");
    source('src/lazy.ts', 'export const value=1;');
    source('src/worker.ts', 'export const value=2;');
    const result = run();
    expect(result.stderr).toBe('');expect(result.status).toBe(0);
  });
  it('rejects unused exported modules that TypeScript does not flag', () => {
    source('entrypoints/main.ts', 'export {};');
    source('src/orphan.ts', 'export function unused() {}');
    const result = run();
    expect(result.status).toBe(1);expect(result.stderr).toContain('Unreachable source module: src/orphan.ts');
  });
  it('rejects unresolved imports of the deleted library facade', () => {
    source('entrypoints/main.ts', "import '../src/library/store';");
    expect(run().stderr).toContain('removed library model');
  });
  it.each(['indexedDB.open("unsafe")', 'navigator.storage.getDirectory()'])('rejects direct UI byte storage: %s', code => {
    source('entrypoints/main.ts', "import '../src/ui/Library';"); source('src/ui/Library.ts', code);
    expect(run().stderr).toContain('UI accesses IDB/OPFS');
  });
  it('requires UI reads to go through application services', () => {
    source('entrypoints/main.ts', "import '../src/ui/Library';"); source('src/ui/Library.ts', "import '../comics/repositories';"); source('src/comics/repositories/index.ts', 'export {};');
    expect(run().stderr).toContain('UI must use application/page services');
  });
  it('rejects format dependencies on Drive even through shared reexports', () => {
    source('entrypoints/main.ts', "import '../src/comics/formats/pdf';");
    source('src/comics/formats/pdf.ts', "import '../../helper';"); source('src/helper.ts', "export * from './comics/sources/google-drive';"); source('src/comics/sources/google-drive/index.ts', 'export {};');
    expect(run().stderr).toContain('format transitive source/translation dependency');
  });
  it('keeps source and translated image cache policies independent', () => {
    source('entrypoints/main.ts', "import '../src/storage/source-pages';"); source('src/storage/source-pages/index.ts', "import '../translations';"); source('src/storage/translations/index.ts', 'export {};');
    expect(run().stderr).toContain('source/page service depends on translations');
  });
  it.each(['src/comics/pages/service.ts','src/comics/application/import.ts','src/ui/Sources.ts','src/comics/sources/registry.ts'])('rejects provider coupling through a re-export from %s', name => {
    source('entrypoints/main.ts', `import '../${name.replace(/\.ts$/,'')}';`);
    const helper = 'src/shared-provider.ts';
    const relativeHelper = path.posix.relative(path.posix.dirname(name), helper).replace(/\.ts$/,'');
    source(name, `import './${relativeHelper}';`);
    const provider = 'src/comics/sources/test-provider/driver.ts';
    const relativeProvider = path.posix.relative(path.posix.dirname(helper), provider).replace(/\.ts$/,'');
    source(helper, `export * from './${relativeProvider}';`); source(provider, 'export const driver=1;');
    expect(run().stderr).toContain('shared code depends on a concrete file source');
  });
  it('keeps cache budgets and persistence outside file providers', () => {
    source('entrypoints/main.ts', "import '../src/comics/sources/install';");
    source('src/comics/sources/install.ts', "import './test-provider/driver';");
    source('src/comics/sources/test-provider/driver.ts', "import '../../../storage/source-ranges';");
    source('src/storage/source-ranges/index.ts', 'export {};');
    expect(run().stderr).toContain('file source depends on another provider or application/cache policy');
  });
  it('allows a composition root to install independent source drivers', () => {
    source('entrypoints/main.ts', "import '../src/comics/sources/install'; import '../src/comics/pages/service';");
    source('src/comics/sources/install.ts', "import './test-provider/driver'; import './registry';");
    source('src/comics/sources/test-provider/driver.ts', "import type {Driver} from '../contracts'; export const driver:Driver={};");
    source('src/comics/sources/contracts.ts', 'export interface Driver {}');
    source('src/comics/sources/registry.ts', "import type {Driver} from './contracts'; export const drivers:Driver[]=[];");
    source('src/comics/pages/service.ts', "import '../sources/registry';");
    expect(run().status).toBe(0);
  });
});
