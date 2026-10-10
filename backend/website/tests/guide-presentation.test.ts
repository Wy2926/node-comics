import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dictionaries, locales, publicPaths } from '../src/i18n';
import { guidePresentation } from '../src/i18n/guide-presentation';

test('desktop tutorials have complete, independently captured Chinese, Japanese, Korean and English image sets', () => {
  const names = ['channel-form.webp', 'library.webp', 'reader-directory.webp', 'reader-settings.webp', 'remote-library.webp', 'search-results.webp', 'search.webp', 'translation-settings.webp'];
  const hashes = new Set<string>();
  for (const locale of ['zh-CN', 'en', 'ja', 'ko']) {
    const directory = new URL(`../src/assets/guides/${locale}/`, import.meta.url);
    assert.deepEqual(readdirSync(directory).sort(), names, locale);
    for (const name of names) {
      const image = readFileSync(new URL(name, directory));
      assert.equal(image.toString('ascii', 0, 4), 'RIFF', name);
      assert.equal(image.toString('ascii', 8, 12), 'WEBP', name);
      assert.ok(image.length < 500_000, `${locale}/${name}: oversized screenshot`);
      const hash = createHash('sha256').update(image).digest('hex');
      assert.ok(!hashes.has(hash), `${locale}/${name}: screenshots must not be relabeled copies`);
      hashes.add(hash);
    }
  }
});

test('all locales have the search workflow, actionable import steps and current quota copy', () => {
  assert.deepEqual(Object.keys(guidePresentation).sort(), [...locales].sort());
  assert.ok(publicPaths.includes('/guides/find-manga/'));
  for (const locale of locales) {
    const { documents } = dictionaries[locale];
    const search = documents.guides.find(guide => guide.slug === 'find-manga')!;
    assert.equal(search.sections.length, 4);
    assert.ok(search.title && search.description);
    assert.ok(search.sections.every(section => section.title && section.paragraphs[0]));
    for (const slug of search.related ?? []) assert.ok(documents.guides.some(guide => guide.slug === slug));
    assert.equal(documents.guides.find(guide => guide.slug === 'local-comics')!.sections[0].steps!.length, 3);
    assert.equal(documents.guides.find(guide => guide.slug === 'translation-modes')!.sections[1].paragraphs[1], documents.faqs.find(faq => faq.id === 'free-plan')!.answer);
    assert.deepEqual(Object.keys(guidePresentation[locale]).sort(), Object.keys(guidePresentation.en).sort());
    assert.ok(Object.values(guidePresentation[locale]).every(value => value.trim()));
  }
});

test('tutorials use static responsive images and accessible full-size links without a client framework', () => {
  const section = readFileSync(new URL('../src/components/ArticleSection.astro', import.meta.url), 'utf8');
  assert.match(section, /widths=\{\[480, 800, 1200, 1440\]\}/);
  assert.match(section, /loading="lazy"/);
  assert.match(section, /href=\{image.src\}/);
  assert.match(section, /aria-label=\{`\$\{section.title\}/);
  for (const name of ['GuideArticle', 'GuideDirectory']) {
    const source = readFileSync(new URL(`../src/components/${name}.astro`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /client:|<script|set:html/);
  }
});
