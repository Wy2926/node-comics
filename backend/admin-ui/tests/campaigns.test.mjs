import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/campaignRules.ts', import.meta.url), 'utf8');
const {outputText} = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}});
const {campaignRules, campaignState, newCampaignDraft, campaignDate, campaignTiming} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const now = Date.parse('2026-01-01T00:00:00Z');
const draft = {...newCampaignDraft(), name: ' 登记赠送 ', pages: '300'};
test('perpetual gifts and ongoing issuance are explicit nulls, no preset quantity', () => {
  assert.equal(newCampaignDraft().pages, '');
  assert.deepEqual(campaignRules(draft, now), {name: '登记赠送', pages: 300, mode: 'classic', audience: 'all', starts_at: null, ends_at: null, validity_days: null});
});
test('page and validity limits reject rounding, zero, exponent and non-finite values', () => {
  for (const pages of ['', '0', '-1', '1.5', '1e2', 'Infinity', '1000001']) assert.throws(() => campaignRules({...draft, pages}, now));
  for (const validity_days of ['0', '-1', '0.5', '36501']) assert.throws(() => campaignRules({...draft, validity_days}, now));
  assert.equal(campaignRules({...draft, pages: '1000000', validity_days: '36500'}, now).validity_days, 36500);
});
test('stop must follow both now and start; dates preserve timezone', () => {
  assert.throws(() => campaignRules({...draft, ends_at: '2026-01-01T00:00:00Z'}, now));
  assert.throws(() => campaignRules({...draft, starts_at: '2026-02-01T00:00:00Z', ends_at: '2026-02-01T00:00:00Z'}, now));
  assert.throws(() => campaignRules({...draft, starts_at: 'invalid'}, now));
  assert.equal(campaignRules({...draft, starts_at: '2026-02-01T08:00:00+08:00'}, now).starts_at, '2026-02-01T00:00:00.000Z');
  assert.equal(campaignDate('2026-02-01T00:00:00').toISOString(), '2026-02-01T00:00:00.000Z');
});
test('cloning starts a new audience cutoff and does not copy stale issuance times or identity', () => {
  const copy = newCampaignDraft({...draft, id: 'original', pages: 500, validity_days: 20, starts_at: '2025-01-01Z', ends_at: '2025-02-01Z', enabled: true});
  assert.equal(copy.pages, '500'); assert.equal(copy.validity_days, '20');
  assert.equal(copy.starts_at, ''); assert.equal(copy.ends_at, '');
  assert.equal(copy.id, undefined); assert.equal(copy.enabled, undefined);
});
test('state distinguishes paused, scheduled, active and exclusive stop boundary', () => {
  const campaign = {enabled: true, starts_at: '2025-12-31T00:00:00Z', ends_at: null};
  assert.equal(campaignState(campaign, now).text, '发放中');
  assert.equal(campaignState({...campaign, enabled: false}, now).text, '已暂停');
  assert.equal(campaignState({...campaign, starts_at: '2026-01-02T00:00:00Z'}, now).text, '待开始');
  assert.equal(campaignState({...campaign, ends_at: '2026-01-01T00:00:00Z'}, now).text, '已结束');
});

test('existing duration edits allow immediate stop but never an end before the original start', () => {
  const starts = Date.parse('2025-12-01T00:00:00Z');
  assert.deepEqual(campaignTiming({validity_days: '7', ends_at: '2025-12-15T00:00:00Z'}, starts), {validity_days: 7, ends_at: '2025-12-15T00:00:00.000Z'});
  assert.throws(() => campaignTiming({validity_days: '7', ends_at: '2025-12-01T00:00:00Z'}, starts));
  assert.deepEqual(campaignTiming({validity_days: '', ends_at: ''}, starts), {validity_days: null, ends_at: null});
});
