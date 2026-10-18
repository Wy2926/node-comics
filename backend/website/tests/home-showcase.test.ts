import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import sharp from 'sharp';
import { locales } from '../src/i18n';
import { homeSamples, homeSampleLanguage, homeSampleLanguages, type HomeSampleKind } from '../src/data/home-samples';
import { galleryCopy, showcaseCopy } from '../src/i18n/home/showcase';

test('showcase copy covers every published locale without changing the SEO dictionaries', () => {
  assert.equal(locales.length, 17);
  assert.deepEqual(Object.keys(showcaseCopy).sort(), [...locales].sort());
  assert.deepEqual(Object.keys(galleryCopy).sort(), [...locales].sort());
  assert.deepEqual(showcaseCopy['zh-CN'].title, ['不离开网页', '读懂眼前的漫画']);
  for (const locale of locales) {
    const copy = showcaseCopy[locale];
    assert.equal(copy.title.length, 2);
    assert.ok(Object.values(copy).flat().every(value => value.trim().length > 0), locale);
    assert.ok(Object.values(galleryCopy[locale]).every(value => value.trim().length > 0), `${locale}: gallery copy`);
  }
});

test('homepage remains statically readable and does not pull in billing or a UI runtime', () => {
  const source = readFileSync(new URL('../src/components/HomePage.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /client:|publishedPlans|publishedSubscriptions|PriceAmount|billing-cycle|home-plan/);
  assert.match(source, /data-home-controls hidden/);
  assert.match(source, /loading="eager" fetchpriority="high"/);
  assert.match(source, /home-image-pair/);
  assert.match(source, /home-search/);
  assert.match(source, /loading="lazy"/);
  assert.match(source, /type="range"/);
  assert.doesNotMatch(source, /data-inline="(?:original|translated)"/);
  assert.doesNotMatch(source, /data-view-choice/);
});

const originals = {
  mono: { filename: 'mono-original.png', locale: 'ja', width: 836, height: 1189, sha256: '575a5436b203fd2d9d8acd6d0492d2a86c7b2364e894640ac59db7151e71b2c5' },
  color: { filename: 'color-original.jpg', locale: 'zh-TW', width: 1129, height: 1602, sha256: '08f6c46135f6f91cf1c92ca67dcc92f1154d7c1e3125a63762630bcbc2532ae3' },
} as const;
const imageDirectory = new URL('../src/assets/home/', import.meta.url);

test('both samples offer every supported target except their own original language', () => {
  assert.deepEqual(Object.keys(homeSamples).sort(), Object.keys(originals).sort());
  for (const kind of Object.keys(originals) as HomeSampleKind[]) {
    const original = originals[kind];
    assert.equal(homeSamples[kind].original, original.filename);
    assert.equal(homeSamples[kind].sourceLocale, original.locale);
    assert.deepEqual(homeSampleLanguages(kind), locales.filter(locale => locale !== original.locale));
    assert.equal(homeSampleLanguages(kind).length, 16);
    for (const locale of locales) {
      assert.equal(homeSampleLanguage(kind, locale), locale === original.locale ? 'en' : locale, `${kind}/${locale}`);
    }
  }
});

test('source artwork is byte-for-byte unchanged and all 32 named translations retain its dimensions', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../assets/home-translations.json', import.meta.url), 'utf8'));
  assert.equal(manifest.schema, 'website-home-translations/1');
  assert.match(manifest.prompt_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(manifest.samples).sort(), Object.keys(originals).sort());
  const expectedNames: string[] = [];
  const outputHashes = new Set<string>();
  for (const kind of Object.keys(originals) as HomeSampleKind[]) {
    const original = originals[kind];
    const sourceBytes = readFileSync(new URL(original.filename, imageDirectory));
    assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), original.sha256, `${kind}: source artwork changed`);
    const provenance = manifest.samples[kind];
    assert.equal(basename(provenance.source), original.filename);
    assert.equal(provenance.source_sha256, original.sha256);
    assert.equal(provenance.width, original.width);
    assert.equal(provenance.height, original.height);
    assert.match(provenance.engine_code_sha256, /^[a-f0-9]{64}$/);
    assert.match(provenance.assets_manifest_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(provenance.targets).sort(), homeSampleLanguages(kind).sort());
    for (const filename of [original.filename, ...homeSampleLanguages(kind).map(locale => `${kind}-${locale}.webp`)]) {
      const bytes = readFileSync(new URL(filename, imageDirectory));
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, original.width, `${filename}: width`);
      assert.equal(metadata.height, original.height, `${filename}: height`);
      if (filename === original.filename) continue;
      expectedNames.push(filename);
      assert.equal(metadata.format, 'webp', filename);
      const hash = createHash('sha256').update(bytes).digest('hex');
      assert.notEqual(hash, original.sha256, `${filename}: untranslated source copy`);
      assert.ok(!outputHashes.has(hash), `${filename}: duplicate translation bytes`);
      outputHashes.add(hash);
      const locale = filename.slice(kind.length + 1, -'.webp'.length);
      const recorded = provenance.targets[locale];
      assert.equal(basename(recorded.file), filename);
      assert.equal(recorded.sha256, hash, `${filename}: stale provenance digest`);
      assert.equal(recorded.byte_size, bytes.byteLength);
      assert.equal(recorded.width, original.width);
      assert.equal(recorded.height, original.height);
      assert.ok(recorded.language && recorded.font_id, `${filename}: missing language/font provenance`);
      assert.match(recorded.font_sha256, /^[a-f0-9]{64}$/);
    }
  }
  const actualNames = readdirSync(imageDirectory).filter(filename => /^(mono|color)-.+\.webp$/.test(filename));
  assert.deepEqual(actualNames.sort(), expectedNames.sort());
  assert.equal(outputHashes.size, 32);
});
