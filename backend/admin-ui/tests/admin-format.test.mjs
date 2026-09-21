import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

// Exercise the exported formatting functions from their real TSX modules without
// a browser, generated files, or an additional test dependency.
const nativeRequire = createRequire(import.meta.url), modules = new Map();
globalThis.sessionStorage = {getItem: () => null};
function load(relative, parent = import.meta.url) {
  let url = new URL(relative, parent);
  if (!/\.tsx?$/.test(url.pathname)) url = new URL(relative + (existsSync(new URL(relative + '.ts', parent)) ? '.ts' : '.tsx'), parent);
  if (modules.has(url.href)) return modules.get(url.href).exports;
  const module = {exports: {}};
  modules.set(url.href, module);
  const {outputText} = ts.transpileModule(readFileSync(url, 'utf8'), {
    fileName: fileURLToPath(url), compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX},
  });
  new Function('require', 'module', 'exports', outputText)(name => name.startsWith('.') ? load(name, url) : nativeRequire(name), module, module.exports);
  return module.exports;
}
const {columnText} = load('../src/AdminResource.tsx');
const {billingStatus} = load('../src/billing.ts');
const {auditChanges, flat} = load('../src/AuditLog.tsx');

test('column formatter distinguishes payment pending from event pending and preserves unknown states', () => {
  const event = {key: 'status', title: '事件状态'};
  const order = {...event, formatter: value => billingStatus(value == null ? null : String(value))};
  assert.equal(columnText({status: 'pending'}, event), '待处理');
  assert.equal(columnText({status: 'pending'}, order), '待付款');
  assert.equal(columnText({status: 'partially_refunded'}, order), '部分退款');
  assert.equal(columnText({status: 'new_provider_state'}, order), 'new_provider_state');
  assert.equal(columnText({status: null}, order), '—');
});

test('table money formatting keeps unknown amounts separate from zero across currency units', () => {
  const amount = {key: 'amount', title: '金额', format: 'currency'};
  assert.equal(columnText({amount: null, currency: 'usd'}, amount), '—');
  assert.match(columnText({amount: 0, currency: 'usd'}, amount), /USD\s*0\.00/);
  assert.match(columnText({amount: 1234, currency: 'kwd'}, amount), /KWD\s*1\.234/);
  assert.match(columnText({amount: 1000, currency: 'jpy'}, amount), /JPY\s*1,000/);
  assert.equal(columnText({amount: null}, {...amount, format: 'money'}), '—');
  assert.equal(columnText({amount: 0}, {...amount, format: 'money'}), '¥0.000000');
});

test('new binding audit distinguishes absent fields from explicit null values', () => {
  assert.deepEqual(auditChanges(null, {provider_price_id: null, trial_product_id: null}), [
    {key: 'provider_price_id', before: '未记录', after: '空值'},
    {key: 'trial_product_id', before: '未记录', after: '空值'},
  ]);
  assert.deepEqual(auditChanges({provider_price_id: null}, {}), [
    {key: 'provider_price_id', before: '空值', after: '未记录'},
  ]);
});

test('audit empty objects remain comparable leaves through addition, clearing, and removal', () => {
  assert.deepEqual(flat({config: {}}), {config: {}});
  assert.deepEqual(auditChanges({}, {config: {}}), [{key: 'config', before: '未记录', after: '{}'}]);
  assert.deepEqual(auditChanges({config: {}}, {config: null}), [{key: 'config', before: '{}', after: '空值'}]);
  assert.deepEqual(auditChanges({config: {}}, {}), [{key: 'config', before: '{}', after: '未记录'}]);
  assert.deepEqual(auditChanges({config: {}}, {config: {}}), []);
});

test('nested audit changes retain paths, false and zero, while unchanged values disappear', () => {
  assert.deepEqual(auditChanges({config: {enabled: false, limit: 0, name: 'unchanged'}}, {config: {enabled: true, limit: 1, name: 'unchanged'}}), [
    {key: 'config.enabled', before: '否', after: '是'},
    {key: 'config.limit', before: '0', after: '1'},
  ]);
});
