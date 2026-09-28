import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/translationProviderConfig.ts', import.meta.url), 'utf8');
const {outputText} = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}});
const {providerDraft, providerInput, validateProvider} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const channels = [{id: 'openai', protocols: ['chat_completions', 'responses']}];
const draft = () => ({...providerDraft(), name: 'Supplier', model: 'test-model', api_key: 'test-key'});

test('new and legacy forms default to lowest reasoning and keep weights outside model config', () => {
  const input = providerInput(draft());
  assert.equal(input.config.reasoning_effort, 'none');
  assert.equal(input.text_weight, 1);
  assert.equal(input.title_weight, 1);
  assert.equal(input.requests_per_minute, 60);
  const {reasoning_effort, ...legacy} = input.config;
  const edited = providerDraft({name: 'Legacy', channel: 'openai', enabled: true, config: legacy, text_weight: 3, title_weight: 0, requests_per_minute: 120});
  assert.equal(edited.reasoning_effort, 'none');
  assert.deepEqual(validateProvider(edited, channels, false), {});
  const saved = providerInput(edited);
  assert.equal(saved.text_weight, 3);
  assert.equal(saved.title_weight, 0);
  assert.equal(saved.requests_per_minute, 120);
  assert.ok(!('api_key' in saved));
  assert.ok(!('text_weight' in saved.config) && !('title_weight' in saved.config));
  assert.ok(!('requests_per_minute' in saved.config));
});

test('independent routing weights accept zero and reject invalid or fractional values', () => {
  for (const key of ['text_weight', 'title_weight']) {
    for (const value of ['0', '1', '10000']) assert.ok(!validateProvider({...draft(), [key]: value}, channels, true)[key]);
    for (const value of ['', '-1', '0.5', '10001', 'NaN']) assert.ok(validateProvider({...draft(), [key]: value}, channels, true)[key]);
  }
  assert.equal(providerInput({...draft(), reasoning_effort: 'provider_default'}).config.reasoning_effort, 'provider_default');
  assert.ok(validateProvider({...draft(), reasoning_effort: 'unknown'}, channels, true).reasoning_effort);
  for (const value of ['', '0', '-1', '0.5', '10001']) assert.ok(validateProvider({...draft(), requests_per_minute: value}, channels, true).requests_per_minute);
});
