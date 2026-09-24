import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, locales, localPath, basePath, localeFromPath, publicPaths } from '../src/i18n';
import { homeCopy } from '../src/i18n/home';

test('homepage locales provide complete text and matching gallery/translation entries', () => {
  function check(value: unknown, reference: unknown, path: string) {
    if (typeof reference === 'string') {
      assert.equal(typeof value, 'string', path);
      assert.ok((value as string).trim(), `${path} must not be empty`);
    } else if (Array.isArray(reference)) {
      assert.ok(Array.isArray(value), path);
      assert.equal(value.length, reference.length, path);
      reference.forEach((entry, index) => check(value[index], entry, `${path}.${index}`));
    } else if (reference && typeof reference === 'object') {
      assert.ok(value && typeof value === 'object', path);
      assert.deepEqual(Object.keys(value).sort(), Object.keys(reference).sort(), path);
      for (const [key, entry] of Object.entries(reference)) check((value as Record<string, unknown>)[key], entry, `${path}.${key}`);
    }
  }
  for (const locale of locales) check(homeCopy[locale], homeCopy.en, locale);
});
test('five independent dictionaries cover all public content and account messages',()=>{
  const reference=dictionaries['zh-CN'];
  for(const locale of locales){
    const value=dictionaries[locale];
    assert.deepEqual(Object.keys(value.ui).sort(),Object.keys(reference.ui).sort(),locale);
    assert.deepEqual(Object.keys(value.account??{}).sort(),Object.keys(reference.account??{}).sort(),locale);
    assert.deepEqual(value.documents.guides.map(item=>item.slug),reference.documents.guides.map(item=>item.slug),locale);
    assert.deepEqual(Object.keys(value.documents.policies).sort(),Object.keys(reference.documents.policies).sort(),locale);
    for(const item of value.documents.guides)assert.ok(item.sections.length>=3 && item.sections.every(section=>section.paragraphs.length>0));
    assert.ok(value.documents.faqs.length>=8);
  }
});
test('language switching preserves pages and round-trips all public routes',()=>{
  for(const path of publicPaths)for(const from of locales)for(const to of locales){
    const target=localPath(localPath(path,from),to);
    assert.equal(basePath(target),path);
    assert.equal(localeFromPath(target),to);
  }
});
