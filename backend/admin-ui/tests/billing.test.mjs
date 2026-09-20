import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/billing.ts', import.meta.url), 'utf8');
const {outputText} = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}});
const {minorAmount, priceAmount, money, billingStatus, billingDate} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('confirmed monthly and annual amounts round trip in currency minor units', () => {
  assert.equal(minorAmount('9.99', 'usd'), 999);
  assert.equal(minorAmount('99.99', 'usd'), 9999);
  assert.equal(priceAmount(999, 'usd'), '9.99');
  assert.equal(priceAmount(9999, 'usd'), '99.99');
  assert.match(money(999, 'usd'), /9\.99/);
});

test('money parsing respects currency minor units and rejects fractional truncation', () => {
  assert.equal(minorAmount('1000', 'jpy'), 1000);
  assert.equal(minorAmount('1.001', 'kwd'), 1001);
  assert.equal(minorAmount('0.29', 'usd'), 29);
  assert.equal(minorAmount('10.1', 'usd'), 1010);
  assert.throws(() => minorAmount('1.001', 'usd'), /最多支持/);
  assert.throws(() => minorAmount('100.1', 'jpy'), /最多支持/);
  for (const invalid of ['0', '-1', '1e2', 'Infinity', 'not-a-price', '1000000000000000']) assert.throws(() => minorAmount(invalid, 'usd'));
});

test('missing and zero order totals remain distinct, including uncertain payment states', () => {
  assert.equal(money(null, 'usd'), '—');
  assert.match(money(0, 'usd'), /0\.00/);
  assert.equal(billingStatus('unknown'), '结果待核实');
  assert.equal(billingStatus('paid'), '已支付');
  assert.equal(billingStatus('unrecognized'), 'unrecognized');
});

test('billing timestamps from the UTC database are never interpreted as browser-local time', () => {
  assert.equal(billingDate('2026-09-20T10:20:30').toISOString(), '2026-09-20T10:20:30.000Z');
  assert.equal(billingDate('2026-09-20T10:20:30Z').toISOString(), '2026-09-20T10:20:30.000Z');
  assert.equal(billingDate('2026-09-20T18:20:30+08:00').toISOString(), '2026-09-20T10:20:30.000Z');
});
