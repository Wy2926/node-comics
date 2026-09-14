import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
const configPath = path.join(root, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const {options} = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const normalize = filename => path.resolve(filename).replaceAll('\\', '/');
const relative = filename => path.relative(root, filename).replaceAll('\\', '/');
function files(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename)
      : /(?<!\.test)(?<!\.d)\.tsx?$/.test(entry.name) ? [normalize(filename)] : [];
  });
}

const entrypoints = files(path.join(root, 'entrypoints'));
const modules = new Set([...entrypoints, ...files(path.join(root, 'src'))]);
const graph = new Map();
const runtimeGraph = new Map();
for (const filename of modules) {
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const dependencies = new Set(), runtime = new Set();
  function add(specifier, typeOnly = false) {
    if (!ts.isStringLiteral(specifier)) return;
    const resolved = ts.resolveModuleName(specifier.text.split('?')[0], filename, options, ts.sys).resolvedModule;
    if (!resolved) return; // CSS, WASM and other Vite-managed assets are not TS modules.
    const target = normalize(resolved.resolvedFileName);
    if (!modules.has(target)) return;
    dependencies.add(target);
    if (!typeOnly) runtime.add(target);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly || !clause?.name && named && ts.isNamedImports(named)
        && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly);
      add(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause;
      add(node.moduleSpecifier, node.isTypeOnly || named && ts.isNamedExports(named)
        && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
      add(node.arguments[0]);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[0]) {
      // Vite worker entrypoints use new Worker(new URL('./worker.ts', import.meta.url)).
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  graph.set(filename, dependencies);
  runtimeGraph.set(filename, runtime);
}

const errors = [], reachable = new Set(), visited = new Set(), stack = [];
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
  console.log(`Checked ${modules.size} modules: no runtime import cycles or unreachable source modules.`);
}
