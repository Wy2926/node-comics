import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { locales } from '../src/i18n';

test('language flags use explicit external assets instead of a per-page data URL', () => {
  const source = readFileSync(new URL('../src/components/LanguageFlag.astro', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '\.\.\/assets\/flags\/([a-z]{2})\.svg\?url&no-inline'/g)];
  assert.equal(imports.length, locales.length);
  assert.equal(new Set(imports.map(match => match[1])).size, locales.length);
  assert.doesNotMatch(source, /\?raw|data:image|encodeURIComponent/);
  assert.match(source, /loading = 'lazy'/);
  for (const name of ['../src/layouts/Base.astro', '../src/components/PaymentSuccess.astro', '../src/components/UninstallPage.astro']) {
    const page = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.equal((page.match(/<LanguageFlag locale=\{locale\} loading="eager"\/>/g) ?? []).length, 1);
  }
});

test('mobile screenshot originals retain their recorded bytes after moving into the image pipeline', () => {
  const assets = readFileSync(new URL('../ASSETS.md', import.meta.url), 'utf8');
  const records = [...assets.matchAll(/\[src\/assets\/guides\/firefox\/([^\]]+)\][^\n]+`([a-f0-9]{64})`/g)];
  assert.equal(records.length, 6);
  for (const [, path, expected] of records) {
    const original = readFileSync(new URL(`../src/assets/guides/firefox/${path}`, import.meta.url));
    assert.equal(createHash('sha256').update(original).digest('hex'), expected, path);
  }
});
