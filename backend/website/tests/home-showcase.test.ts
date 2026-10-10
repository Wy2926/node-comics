import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { locales } from '../src/i18n';
import { showcaseCopy } from '../src/i18n/home/showcase';

test('showcase copy covers every published locale without changing the SEO dictionaries', () => {
  assert.deepEqual(Object.keys(showcaseCopy).sort(), [...locales].sort());
  for (const locale of locales) {
    const copy = showcaseCopy[locale];
    assert.equal(copy.title.length, 2);
    assert.ok(Object.values(copy).flat().every(value => value.trim().length > 0), locale);
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
