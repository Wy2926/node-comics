import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/systemSettingsConfig.ts', import.meta.url), 'utf8');
const {outputText} = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}});
const {numericFields, promptFields, promptMaxLength, settingKeys, normalizePrompt, promptLength, toDraft, changed, mergeDraft, validate} =
  await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const values = () => ({
  image_result_retention_days: 7,
  empty_claim_retention_days: 1, completed_claim_retention_days: 7, execution_detail_retention_days: 90,
  free_daily_pages: 30, free_images_per_minute: 10, plus_images_per_minute: 100,
  upload_user_concurrency: 10, upload_global_concurrency: 16, upload_idle_timeout_seconds: 15,
  upload_body_timeout_seconds: 120, upload_ingress_lease_seconds: 45,
  feedback_requests_per_minute: 30, feedback_request_burst: 10, feedback_receipts_per_day: 100,
  guest_daily_limit: 5, guest_network_daily_limit: 100, guest_global_daily_limit: 10000,
  comic_translation_prompt: '保留作品专名、语气与梗。\n不要补写剧情。',
  comic_title_prompt: '优先可靠的通行作品名称，不编造官方译名。',
});

test('complete settings round-trip keeps numeric limits and both prompt strings', () => {
  const saved = values();
  const draft = toDraft(saved);
  const result = validate(draft);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.values, saved);
  assert.equal(settingKeys.length, numericFields.length + promptFields.length);
  assert.ok(settingKeys.every(key => !changed(draft, saved, key)));
  assert.equal(typeof result.values.comic_translation_prompt, 'string');
  assert.equal(typeof result.values.free_daily_pages, 'number');
});

test('prompt normalization preserves inner content and compares normalized saved text', () => {
  const saved = values();
  const draft = toDraft(saved);
  draft.comic_translation_prompt = ' \r\n保留作品专名、语气与梗。\r\n不要补写剧情。\r\n\t';
  assert.equal(normalizePrompt(draft.comic_translation_prompt), saved.comic_translation_prompt);
  assert.equal(changed(draft, saved, 'comic_translation_prompt'), false);
  assert.equal(validate(draft).values.comic_translation_prompt, saved.comic_translation_prompt);
  draft.comic_translation_prompt = '保留  内部空格\r与\t制表符';
  assert.equal(validate(draft).values.comic_translation_prompt, '保留  内部空格\n与\t制表符');
  assert.equal(changed(draft, saved, 'comic_translation_prompt'), true);
  assert.equal(normalizePrompt('\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000内容\u3000'), '内容');
  assert.equal(normalizePrompt('\ufeff内容\ufeff'), '\ufeff内容\ufeff');
});

test('prompt limits use Unicode code points, including supplementary characters', () => {
  for (const {key} of promptFields) {
    const draft = toDraft(values());
    draft[key] = '𠮷'.repeat(promptMaxLength);
    assert.equal(promptLength(draft[key]), promptMaxLength);
    assert.equal(validate(draft).errors[key], undefined);
    draft[key] += '😀';
    assert.equal(promptLength(draft[key]), promptMaxLength + 1);
    assert.ok(validate(draft).errors[key]);
    for (const empty of ['', ' \r\n\t']) {
      draft[key] = empty;
      assert.ok(validate(draft).errors[key]);
      assert.equal(changed(draft, values(), key), true);
    }
  }
});

test('prompts reject control characters and unpaired surrogates while accepting valid pairs', () => {
  for (const {key} of promptFields) {
    const draft = toDraft(values());
    for (const invalid of ['\u0000', '\u0008', '\u000b', '\u000c', '\u000e', '\u001f', '\u007f', '\u0085', '\u009f', '\ud800', '\udfff']) {
      for (const text of [`文字${invalid}文字`, `${invalid}文字${invalid}`]) {
        draft[key] = text;
        assert.ok(validate(draft).errors[key], `${key}: ${JSON.stringify(invalid)}`);
      }
    }
    for (const valid of ['名称𠮷野😀', '行一\n行二', '名称\t说明']) {
      draft[key] = valid;
      assert.equal(validate(draft).errors[key], undefined);
    }
  }
});

test('numeric validation and cross-field constraints still apply with prompt fields', () => {
  for (const field of numericFields) {
    for (const invalid of ['', 'NaN', 'Infinity', String(field.min - 1), String(field.max + 1)]) {
      assert.ok(validate({...toDraft(values()), [field.key]: invalid}).errors[field.key]);
    }
    if (field.integer) assert.ok(validate({...toDraft(values()), [field.key]: '1.5'}).errors[field.key]);
  }
  const concurrency = validate({...toDraft(values()), upload_user_concurrency: '17'});
  assert.ok(concurrency.errors.upload_user_concurrency && concurrency.errors.upload_global_concurrency);
  const timeout = validate({...toDraft(values()), upload_idle_timeout_seconds: '16', upload_body_timeout_seconds: '15'});
  assert.ok(timeout.errors.upload_idle_timeout_seconds && timeout.errors.upload_body_timeout_seconds);
  assert.equal(validate({...toDraft(values()), upload_idle_timeout_seconds: '0.5'}).errors.upload_idle_timeout_seconds, undefined);
});

test('reload merges only edited fields and retains invalid prompt drafts during conflicts', () => {
  const saved = values();
  const draft = {...toDraft(saved), comic_translation_prompt: '我的新规则', feedback_receipts_per_day: '120'};
  const latest = {...saved, free_daily_pages: 50, comic_translation_prompt: '其他管理员的规则', comic_title_prompt: '新版名称规则'};
  const merged = mergeDraft(latest, {values: saved, draft});
  assert.equal(merged.preserved, true);
  assert.equal(merged.draft.comic_translation_prompt, '我的新规则');
  assert.equal(merged.draft.comic_title_prompt, '新版名称规则');
  assert.equal(merged.draft.free_daily_pages, '50');
  assert.equal(merged.draft.feedback_receipts_per_day, '120');
  assert.equal(mergeDraft(latest, {values: saved, draft: {...draft, comic_translation_prompt: ''}}).draft.comic_translation_prompt, '');
  assert.deepEqual(mergeDraft(latest), {draft: toDraft(latest), preserved: false});
  assert.deepEqual(saved, values());
});

test('after successful save the returned prompt values become the clean baseline', () => {
  const original = values();
  const input = {...toDraft(original), comic_translation_prompt: '服务端推荐正文规则', comic_title_prompt: '服务端推荐名称规则'};
  assert.ok(promptFields.every(({key}) => changed(input, original, key)));
  const saved = validate(input).values;
  const refreshed = toDraft(saved);
  assert.ok(settingKeys.every(key => !changed(refreshed, saved, key)));
  assert.equal(original.comic_translation_prompt, values().comic_translation_prompt);
});
