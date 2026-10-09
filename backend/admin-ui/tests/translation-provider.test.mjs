import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/translationProviderConfig.ts', import.meta.url), 'utf8');
const {outputText} = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}});
const {numericFields, providerDraft, providerInput, validateProvider} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const channels = [{id: 'openai', protocols: ['chat_completions', 'responses']}];
const draft = () => ({...providerDraft(), name: 'Supplier', model: 'test-model', api_key: 'test-key'});

test('new and legacy forms default to lowest reasoning and keep weights outside model config', () => {
  const input = providerInput(draft());
  assert.equal(input.config.reasoning_effort, 'none');
  assert.equal(input.text_weight, 1);
  assert.equal(input.title_weight, 1);
  assert.equal(input.requests_per_minute, 60);
  assert.equal(input.text_plan_ids, null);
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

test('plan restrictions round-trip outside model config and cannot save an empty selection', () => {
  const input = providerInput({...draft(), text_plan_ids: ['free', 'lite']});
  assert.deepEqual(input.text_plan_ids, ['free', 'lite']);
  assert.ok(!('text_plan_ids' in input.config));
  assert.deepEqual(providerInput(providerDraft(input)).text_plan_ids, ['free', 'lite']);
  assert.ok(validateProvider({...draft(), text_plan_ids: []}, channels, true).text_plan_ids);
  assert.ok(!validateProvider({...draft(), text_plan_ids: ['plus']}, channels, true).text_plan_ids);
  assert.equal(providerInput({...draft(), text_plan_ids: null}).text_plan_ids, null);
});

test('OpenRouter upstream list preserves priority, validates and clears to default routing', () => {
  const input = {...draft(), base_url: 'https://openrouter.ai/api/v1', openrouter_providers: 'deepinfra, together\ngoogle-vertex/us-east5'};
  assert.deepEqual(validateProvider(input, channels, true), {});
  const saved = providerInput(input);
  assert.deepEqual(saved.config.openrouter_providers, ['deepinfra', 'together', 'google-vertex/us-east5']);
  assert.equal(providerDraft(saved).openrouter_providers, 'deepinfra\ntogether\ngoogle-vertex/us-east5');
  assert.deepEqual(providerInput({...input, openrouter_providers: ''}).config.openrouter_providers, []);
  for (const value of ['same,same', 'bad slug', 'a'.repeat(101), Array.from({length: 21}, (_, n) => `p-${n}`).join(',')]) {
    assert.ok(validateProvider({...input, openrouter_providers: value}, channels, true).openrouter_providers);
  }
  for (const base_url of ['https://api.openai.com/v1', 'https://openrouter.ai.example/v1']) {
    assert.ok(validateProvider({...input, base_url}, channels, true).openrouter_providers);
  }
  assert.deepEqual(providerInput(draft()).config.openrouter_providers, []);
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

test('output limit accepts larger model responses and preserves existing values', () => {
  for (const value of ['128', '8192', '32768']) {
    const input = {...draft(), max_output_tokens: value};
    assert.ok(!validateProvider(input, channels, true).max_output_tokens);
    assert.equal(providerInput(input).config.max_output_tokens, Number(value));
  }
  for (const value of ['127', '32769', '8192.5', 'NaN']) {
    assert.ok(validateProvider({...draft(), max_output_tokens: value}, channels, true).max_output_tokens);
  }
});

test('token prices accept decimals and round-trip without loosening integer fields', () => {
  for (const key of ['input_rate', 'output_rate']) {
    assert.equal(numericFields.find(field => field.key === key).integer, false);
    for (const value of ['0', '0.000001', '0.15', '1.125', '30']) {
      const input = {...draft(), [key]: value};
      assert.ok(!validateProvider(input, channels, true)[key]);
      const saved = providerInput(input);
      assert.equal(saved.config[key], Number(value));
      assert.equal(providerInput(providerDraft(saved)).config[key], Number(value));
    }
    for (const value of ['', '-0.1', '5000.1', 'NaN', 'Infinity']) {
      assert.ok(validateProvider({...draft(), [key]: value}, channels, true)[key]);
    }
  }
  assert.ok(validateProvider({...draft(), input_rate: '1000.1'}, channels, true).input_rate);
  for (const {key, integer} of numericFields.filter(field => field.group !== 'pricing')) {
    assert.equal(integer, true);
    assert.ok(validateProvider({...draft(), [key]: '128.5'}, channels, true)[key]);
  }
});
