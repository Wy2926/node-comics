import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
const configPath = path.join(root, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const normalize = (filename) => path.resolve(filename).replaceAll('\\', '/');
const relative = (filename) => path.relative(root, filename).replaceAll('\\', '/');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? entry.name === 'tests'
        ? []
        : files(filename)
      : /(?<!\.test)(?<!\.d)\.tsx?$/.test(entry.name)
        ? [normalize(filename)]
        : [];
  });
}

const entrypoints = files(path.join(root, 'entrypoints'));
const modules = new Set([...entrypoints, ...files(path.join(root, 'src'))]);
const graph = new Map();
const runtimeGraph = new Map();
const discovered = new Map();
const importErrors = [];
for (const filename of modules) {
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const dependencies = new Set(),
    runtime = new Set();
  const automatic = new Set();
  function add(specifier, typeOnly = false) {
    if (!ts.isStringLiteral(specifier)) return;
    // Reject a removed module even when TypeScript resolution fails; no compatibility façade.
    if (/(?:^|\/)library(?:\/|$)/.test(specifier.text))
      importErrors.push(`Comic boundary (removed library model): ${relative(filename)} -> ${specifier.text}`);
    const resolved = ts.resolveModuleName(
      specifier.text.split('?')[0],
      filename,
      options,
      ts.sys,
    ).resolvedModule;
    if (!resolved) return; // CSS, WASM and other Vite-managed assets are not TS modules.
    const target = normalize(resolved.resolvedFileName);
    const targetSite = relative(target).match(/^src\/sources\/sites\/([^/]+)\//)?.[1];
    const owner = relative(filename).match(/^src\/sources\/sites\/([^/]+)\//)?.[1];
    if (targetSite && targetSite !== owner)
      importErrors.push(`Source boundary (concrete site imports require same site; registries must use uniform discovery): ${relative(filename)} -> ${relative(target)}`);
    if (!modules.has(target)) return;
    dependencies.add(target);
    if (!typeOnly) runtime.add(target);
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.MetaProperty && node.expression.name.text === 'glob') {
      const pattern = node.arguments[0];
      const kind = relative(filename).match(/^src\/sources\/registry\/(definitions|pages|networks|images)\.ts$/)?.[1];
      const file = {definitions:'definition',pages:'page',networks:'network',images:'image'}[kind];
      if (!file || !pattern || !ts.isStringLiteral(pattern) || pattern.text !== `../sites/*/${file}.ts`) {
        importErrors.push(`Source boundary (only uniform registry discovery is allowed): ${relative(filename)}`);
      } else {
        for (const target of modules) if (new RegExp(`^src/sources/sites/[^/]+/${file}\\.ts$`).test(relative(target))) {
          dependencies.add(target); runtime.add(target); automatic.add(target);
        }
      }
    } else if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly ||
        (!clause?.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((element) => element.isTypeOnly));
      add(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause;
      add(
        node.moduleSpecifier,
        node.isTypeOnly ||
          (named &&
            ts.isNamedExports(named) &&
            named.elements.length > 0 &&
            named.elements.every((element) => element.isTypeOnly)),
      );
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0]
    ) {
      add(node.arguments[0]);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.[0]
    ) {
      // Vite worker entrypoints use new Worker(new URL('./worker.ts', import.meta.url)).
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  graph.set(filename, dependencies);
  runtimeGraph.set(filename, runtime);
  discovered.set(filename, automatic);
}

const errors = [...importErrors],
  reachable = new Set(),
  visited = new Set(),
  stack = [];
const sourcePart = (filename) => relative(filename).match(/^src\/sources\/(.+)$/)?.[1];
const site = (filename) => sourcePart(filename)?.match(/^sites\/([^/]+)\//)?.[1];
for (const [filename, dependencies] of graph) {
  const part = sourcePart(filename),
    owner = site(filename);
  const from = relative(filename), ui = /^src\/(?:ui|reader)\//.test(from), format = from.startsWith('src/comics/formats/');
  if (from.startsWith('src/library/')) errors.push(`Comic boundary (removed library model): ${from}`);
  for (const target of dependencies) {
    const destination = sourcePart(target),
      targetSite = site(target);
    const to = relative(target);
    if ((ui || from === 'src/App.tsx' || /^src\/comics\/(?:application|pages)\//.test(from)) && /^src\/sources\/(?:runtime|registry)\//.test(to))
      errors.push(`Source boundary (application must use the public source API): ${from} -> ${to}`);
    if (ui && (to.startsWith('src/comics/repositories/') || to.startsWith('src/storage/')))
      errors.push(`Comic boundary (UI must use application/page services): ${from} -> ${to}`);
    if (format && /^src\/(?:comics\/(?:sources|repositories|application)|storage|translation)\//.test(to))
      errors.push(`Comic boundary (format driver depends on source, persistence or translation): ${from} -> ${to}`);
    if (/^src\/(?:comics\/(?:pages|sources)|storage\/source-(?:pages|ranges))\//.test(from) && /^src\/(?:translation|storage\/translations)\//.test(to))
      errors.push(`Comic boundary (source/page service depends on translations): ${from} -> ${to}`);
    const fail = (reason) =>
      errors.push(`Source boundary (${reason}): ${relative(filename)} -> ${relative(target)}`);
    if (targetSite && owner !== targetSite && !discovered.get(filename)?.has(target))
      fail('concrete site imports require same site; registries must use uniform discovery');
    if (
      destination?.startsWith('generic/') &&
      !part?.startsWith('generic/') &&
      !part?.startsWith('registry/')
    )
      fail('generic imports require registry');
    if (
      part?.startsWith('core/') &&
      (destination?.startsWith('registry/') ||
        destination?.startsWith('runtime/') ||
        destination === 'index.ts' ||
        destination === 'page.ts')
    )
      fail('core cannot import composition/runtime');
    if ((owner || part?.startsWith('generic/')) && !destination && !relative(target).startsWith('src/i18n/'))
      fail('adapter depends on application');
    if (
      (owner || part?.startsWith('generic/')) &&
      destination &&
      !/^(sites\/|generic\/|contracts\/|shared\/)/.test(destination)
    )
      fail('adapter depends on execution layer');
    if (
      part &&
      /^(shared|contracts)\//.test(part) &&
      destination &&
      !/^(shared|contracts)\//.test(destination)
    )
      fail('utility depends on execution layer');
    if (
      part &&
      /^(shared|contracts)\//.test(part) &&
      !destination &&
      !relative(target).startsWith('src/i18n/')
    )
      fail('utility depends on application');
  }
  if (owner || part?.startsWith('generic/') || ui || format) {
    const source = ts.createSourceFile(
      filename,
      fs.readFileSync(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if ((owner || part?.startsWith('generic/')) && ts.isIdentifier(node) && ['chrome', 'browser'].includes(node.text))
        errors.push(`Source boundary (adapter browser API): ${relative(filename)}`);
      if ((ui || format) && ts.isIdentifier(node) && ['indexedDB', 'IDBKeyRange', 'getDirectory', 'createSyncAccessHandle', 'showDirectoryPicker'].includes(node.text))
        errors.push(`Comic boundary (${ui ? 'UI' : 'format'} accesses IDB/OPFS): ${from} (${node.text})`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
// Re-exporting a helper must not provide a hidden path from pure drivers/caches into translation.
function checkTransitiveBoundary(filename, predicate, label, seen = new Set()) {
  if (seen.has(filename)) return;
  seen.add(filename);
  for (const dependency of graph.get(filename) ?? []) {
    if (predicate(relative(dependency))) errors.push(`Comic boundary (${label}): ${relative(filename)} -> ${relative(dependency)}`);
    checkTransitiveBoundary(dependency, predicate, label, seen);
  }
}
for (const filename of modules) {
  const name = relative(filename);
  const concreteSource = target => /^src\/comics\/sources\/[^/]+\//.test(target);
  if (name.startsWith('src/comics/formats/')) checkTransitiveBoundary(filename, target => concreteSource(target) || /^src\/(?:translation|storage\/translations)\//.test(target), 'format transitive source/translation dependency');
  if (name === 'src/App.tsx' || /^src\/(?:comics\/(?:application|domain|pages|repositories)|ui|reader|translation|export|storage)\//.test(name) ||
      /^src\/comics\/sources\/(?:contracts|registry|runtime)\.ts$/.test(name)) {
    checkTransitiveBoundary(filename, concreteSource, 'shared code depends on a concrete file source');
  }
  const provider = /^src\/comics\/sources\/([^/]+)\//.exec(name)?.[1];
  if (provider) checkTransitiveBoundary(filename, target => {
    const other = /^src\/comics\/sources\/([^/]+)\//.exec(target)?.[1];
    return (other && other !== provider) || /^src\/(?:comics\/(?:application|pages|repositories)|ui|reader|translation|storage\/(?:cache|source-pages|source-ranges|thumbnails|translations))\//.test(target);
  }, 'file source depends on another provider or application/cache policy');
  if (/^src\/storage\/source-(?:pages|ranges)\//.test(name)) checkTransitiveBoundary(filename, target => target.startsWith('src/storage/translations/'), 'source cache transitive translation dependency');
}
// A type-only DOM declaration is harmless; runtime transitive dependencies are not.
function pureDefinition(filename, seen = new Set()) {
  if (seen.has(filename)) return;
  seen.add(filename);
  const part = sourcePart(filename);
  if (part && (/^(runtime|generic\/page|registry\/pages)\b/.test(part) || /\/page(?:s)?\.ts$/.test(part)))
    errors.push(`Source definition loads page code: ${relative(filename)}`);
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node) => {
    if (
      ts.isTypeNode(node) ||
      ts.isInterfaceDeclaration(node) ||
      (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
    )
      return;
    if (
      ts.isIdentifier(node) &&
      [
        'document',
        'window',
        'chrome',
        'browser',
        'HTMLCanvasElement',
        'CanvasRenderingContext2D',
        'MutationObserver',
        'getComputedStyle',
      ].includes(node.text)
    )
      errors.push(`Source definition uses page/browser global: ${relative(filename)} (${node.text})`);
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      /\.(css|scss)(\?|$)/.test(node.moduleSpecifier.text)
    )
      errors.push(`Source definition loads CSS: ${relative(filename)}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const dependency of runtimeGraph.get(filename) ?? []) pureDefinition(dependency, seen);
}
for (const filename of modules)
  if (/\/sources\/(?:sites\/[^/]+|generic)\/definition\.ts$/.test(filename)) pureDefinition(filename);
function reach(filename) {
  if (reachable.has(filename)) return;
  reachable.add(filename);
  for (const dependency of graph.get(filename)) reach(dependency);
}
function detectCycles(filename) {
  const index = stack.indexOf(filename);
  if (index !== -1) {
    errors.push(`Runtime import cycle: ${[...stack.slice(index), filename].map(relative).join(' -> ')}`);
    return;
  }
  if (visited.has(filename)) return;
  stack.push(filename);
  for (const dependency of runtimeGraph.get(filename)) detectCycles(dependency);
  stack.pop();
  visited.add(filename);
}
for (const entrypoint of entrypoints) reach(entrypoint);
for (const filename of modules) {
  detectCycles(filename);
  if (!reachable.has(filename)) errors.push(`Unreachable source module: ${relative(filename)}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${modules.size} modules: comic/source boundaries, pure definitions, runtime cycles and reachability passed.`,
  );
}
