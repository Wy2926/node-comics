import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserLocale, languageSuggestion, languageTarget, manualLocale} from '../src/lib/language-preference';
import {locales, localPath} from '../src/i18n/locales';

test('browser languages use preference order and supported regional variants',()=>{
  for (const locale of locales) assert.equal(browserLocale([locale]),locale);
  for (const [tag,expected] of [['zh-Hant-CN','zh-TW'],['zh-Hans-HK','zh-CN'],['zh-HK','zh-TW'],['pt-PT','pt-BR'],['en-GB','en'],['id_ID','id']] as const) assert.equal(browserLocale([tag]),expected);
  for (const tag of ['ar-SA','ar-EG','ar_AE']) assert.equal(browserLocale([tag]),'ar');
  assert.equal(browserLocale(['ar','fr-CA','en']), 'ar');
  assert.equal(browserLocale(['fa','fr-CA','en']), 'fr');
  assert.equal(browserLocale(['fa','xx']), undefined);
});
test('suggestion respects manual choice, dismissal and in-progress private flows',()=>{
  assert.equal(languageSuggestion('/guides/local-comics/','zh-CN',['de-DE']), 'de');
  assert.equal(languageSuggestion('/de/','de',['de-DE']), undefined);
  assert.equal(languageSuggestion('/','zh-CN',['fr'],'nc-site-locale=en'), undefined);
  assert.equal(languageSuggestion('/','zh-CN',['fr'],'','fr'), undefined);
  assert.equal(manualLocale('nc-site-locale=invalid'), undefined);
  for (const locale of locales) for (const route of ['/translate/','/account/','/auth/callback/','/payment/success/','/uninstall/','/404/']) assert.equal(languageSuggestion(localPath(route,locale),locale,['fr']),undefined);
});
test('manual switch keeps the current article, query and anchor',()=>{
  assert.equal(languageTarget(new URL('https://comics.nodelane.net/en/guides/local-comics/?from=help#section-2'),'pt-BR'),'/pt-br/guides/local-comics/?from=help#section-2');
});
