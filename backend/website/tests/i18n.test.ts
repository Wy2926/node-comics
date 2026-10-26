import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, locales, localPath, basePath, localeFromPath, publicPaths } from '../src/i18n';
import {translationCopy} from '../src/i18n/translate';
import {uninstallCopy} from '../src/i18n/uninstall';
import {paymentSuccess} from '../src/i18n/payment-success';
import {projectCopy} from '../src/i18n/project';
import {languageNoticeCopy} from '../src/i18n/language-notice';
import {commerceCopy} from '../src/i18n/commerce';
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
test('seventeen independent dictionaries cover all public content and account messages',()=>{
  const reference=dictionaries['zh-CN'];
  for(const locale of locales){
    const value=dictionaries[locale];
    assert.deepEqual(Object.keys(value.ui).sort(),Object.keys(reference.ui).sort(),locale);
    assert.deepEqual(Object.keys(value.account??{}).sort(),Object.keys(reference.account??{}).sort(),locale);
    assert.deepEqual(value.documents.guides.map(item=>item.slug),reference.documents.guides.map(item=>item.slug),locale);
    assert.deepEqual(Object.keys(value.documents.policies).sort(),Object.keys(reference.documents.policies).sort(),locale);
    for(const item of value.documents.guides)assert.ok(item.sections.length>=3 && item.sections.every(section=>section.paragraphs.length>0 || (section.links?.length && section.links.every(link=>link.label.trim() && link.href.trim()))));
    assert.deepEqual(value.documents.faqs.map(item=>item.id),reference.documents.faqs.map(item=>item.id),locale);
    assert.equal(new Set(value.documents.faqs.map(item=>item.id)).size,value.documents.faqs.length,locale);
    for(const faq of value.documents.faqs){
      assert.match(faq.id,/^[a-z]+(?:-[a-z]+)*$/);
      assert.ok(faq.question.trim() && faq.answer.trim(),`${locale}: empty FAQ`);
      assert.ok(publicPaths.includes(faq.relatedPath),`${locale}: missing related page ${faq.relatedPath}`);
    }
  }
});
test('language switching preserves pages and round-trips all public routes',()=>{
  for(const path of publicPaths)for(const from of locales)for(const to of locales){
    const target=localPath(localPath(path,from),to);
    assert.equal(basePath(target),path);
    assert.equal(localeFromPath(target),to);
  }
});


test('localized releases have stable unique anchors and matching entries',()=>{
  const reference=dictionaries['zh-CN'].documents.releases;
  for(const locale of locales){
    const releases=dictionaries[locale].documents.releases;
    const anchors=releases.map(release=>release.id??release.date);
    assert.equal(new Set(anchors).size,anchors.length,locale);
    assert.deepEqual(anchors,reference.map(release=>release.id??release.date),locale);
    assert.deepEqual(releases.map(release=>release.date),reference.map(release=>release.date),locale);
  }
});

test('1.1.0 leads every changelog with four concise user-facing highlights',()=>{
  for(const locale of locales){
    const release=dictionaries[locale].documents.releases[0];
    assert.equal(release.id,'1.1.0',locale);
    assert.equal(release.date,'2026-10-27',locale);
    assert.ok(release.title.includes(release.id),locale);
    assert.equal(release.items.length,4,locale);
    assert.equal(new Set(release.items).size,4,locale);
    assert.ok(release.items.every(item=>item.trim().length>0 && item.length<=200),locale);
    assert.doesNotMatch([release.title,...release.items].join(' '),/待发布|待商店发布|pending (?:store )?release|AMO|SHA-256|manifest\.key|git commit/i,locale);
  }
});

test('0.12.0 and 0.11.3 describe user-facing features in every locale',()=>{
  for(const locale of locales){
    const releases=dictionaries[locale].documents.releases.filter(({id})=>id==='0.12.0'||id==='0.11.3');
    assert.deepEqual(releases.map(({id,date})=>[id,date]),[['0.12.0','2026-10-13'],['0.11.3','2026-10-10']],locale);
    for(const release of releases){
      assert.ok(release.title.includes(release.id!),locale);
      assert.equal(release.items.length,5,locale);
      assert.equal(new Set(release.items).size,5,locale);
      assert.ok(release.items.every(item=>item.trim().length>0),locale);
      assert.doesNotMatch([release.title,...release.items].join(' '),/待商店发布|pending store release|AMO|SHA-256|manifest\.key|Chrome 0\.11\.3|Edge 0\.10\.2/i,locale);
    }
    for(const term of ['nunif / waifu2x','EPUB','PDF','ZIP / CBZ','COMIC FUZ','Zebrack','再漫画','Manga One','Hachiraw','MangaTaro','WebtoonScan'])
      assert.ok(releases[0].items.some(item=>item.includes(term)),`${locale}: ${term}`);
    for(const term of ['ComicK (comickz)','ComicWalker',"HERO'S Web"])
      assert.ok(releases[1].items.some(item=>item.includes(term)),`${locale}: ${term}`);
  }
});

test('official package instructions distinguish restricted CRX and signed Firefox installation',()=>{
  for(const locale of locales){
    const ui=dictionaries[locale].ui;
    const steps=[ui.installStepDownload,ui.installStepBrowser,ui.installStepLoad];
    assert.ok(steps.every(step=>step.trim().length>0),locale);
    for(const term of ['Chrome','Edge','CRX'])assert.ok(steps[1].includes(term),`${locale}: ${term}`);
    for(const term of ['Firefox','AMO','XPI'])assert.ok(steps[2].includes(term),`${locale}: ${term}`);
    assert.ok(ui.manualUpdateNote.includes('Windows/macOS')&&ui.manualUpdateNote.includes('Chrome'),locale);
    assert.doesNotMatch([ui.installTitle,ui.directDownloadDescription,...steps,ui.manualUpdateNote].join(' '),/ZIP|manifest\.json|chrome:\/\/extensions|edge:\/\/extensions/,locale);
  }
});

test('0.10.0 remains in every locale with all seven extension highlights',()=>{
  for(const locale of locales){
    const release=dictionaries[locale].documents.releases.find(release=>release.id==='0.10.0');
    assert.ok(release,locale);
    assert.equal(release.date,'2026-10-04',locale);
    assert.ok(release.title.includes('0.10.0'),locale);
    assert.equal(release.items.length,8,locale);
    assert.ok(release.items.some(item=>item.includes('Firefox 0.10.0') && item.includes('AMO')),locale);
    for(const term of ['OPDS','OCR','EPUB','MangaPill','MangaDNA','KLManga','RawLazy','Comic DAYS','Manga One'])
      assert.ok(release.items.some(item=>item.includes(term)),`${locale}: ${term}`);
  }
});

test('0.9.1 replaces the superseded 0.9.0 notes in every locale',()=>{
  for(const locale of locales){
    const releases=dictionaries[locale].documents.releases;
    const release=releases.find(release=>release.id==='0.9.1');
    assert.ok(release,locale);
    assert.ok(release.title.includes('0.9.1'),locale);
    assert.ok(release.items.some(item=>item.includes('JPEG')),locale);
    assert.ok(release.items.some(item=>item.includes('AVIF')),locale);
    assert.ok(release.items.some(item=>item.includes('Firefox 0.9.1')&&item.includes('AMO')),locale);
    assert.ok(!release.items.some(item=>item.includes('Firefox')&&item.includes('0.8.0')),locale);
    assert.ok(!releases.some(release=>release.id==='0.9.0'),locale);
    assert.ok(releases.some(release=>release.id==='0.8.0'),locale);
  }
});


test('seventeen locales include workspace, feedback, payment, project and browser-language copy',()=>{
  assert.equal(locales.length,17);
  for(const table of [translationCopy,uninstallCopy,paymentSuccess,projectCopy,languageNoticeCopy]) {
    assert.deepEqual(Object.keys(table).sort(),[...locales].sort());
    for(const locale of locales) assert.deepEqual(Object.keys(table[locale]).sort(),Object.keys(table.en).sort(),locale);
  }
});

test('new dictionaries translate all prose and preserve structures and technical identifiers',()=>{
  const structural = new Set(['slug','id','published','updated','date','relatedPath','href','code','related']);
  function check(value:unknown,reference:unknown,path:string,key='') {
    if(typeof reference==='string') {
      assert.equal(typeof value,'string',path);
      assert.ok((value as string).trim(),path);
      if(structural.has(key) && !path.includes('.ui.')) assert.equal(value,reference,path);
      else {
        assert.deepEqual((value as string).match(/\{\w+\}/g)?.sort()??[],reference.match(/\{\w+\}/g)?.sort()??[],path);
        if(reference.length>100) assert.notEqual(value,reference,`untranslated prose: ${path}`);
      }
    } else if(Array.isArray(reference)) {
      assert.ok(Array.isArray(value),path);
      assert.equal(value.length,reference.length,path);
      reference.forEach((item,index)=>check(value[index],item,`${path}.${index}`,key));
    } else if(reference&&typeof reference==='object') {
      assert.ok(value&&typeof value==='object',path);
      assert.deepEqual(Object.keys(value).sort(),Object.keys(reference).sort(),path);
      for(const [field,item] of Object.entries(reference)) check((value as Record<string,unknown>)[field],item,`${path}.${field}`,field);
    } else assert.equal(value,reference,path);
  }
  const original=['zh-CN','zh-TW','en','ja','ko'];
  const referenceCommerce=commerceCopy('fr');
  for(const locale of locales.filter(locale=>!original.includes(locale))) {
    check(dictionaries[locale],dictionaries.en,locale);
    check(homeCopy[locale],homeCopy.en,locale+'.home');
    check(translationCopy[locale],translationCopy.en,locale+'.translate');
    check(uninstallCopy[locale],uninstallCopy.en,locale+'.uninstall');
    check(paymentSuccess[locale],paymentSuccess.en,locale+'.payment');
    check(projectCopy[locale],projectCopy.en,locale+'.project');
    assert.deepEqual(Object.keys(commerceCopy(locale)).sort(),Object.keys(referenceCommerce).sort(),locale+'.commerce');
  }
});
