import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {translationBody} from '../src/lib/translation-api';
import type {RecordMeta} from '../src/lib/translation-store';
import TranslationModelPicker from '../src/components/TranslationModelPicker';
import {modelCopy} from '../src/i18n/translation-models';
import {locales} from '../src/i18n/locales';
import {selectedModelAvailable} from '../../shared/translation-models';

const record:RecordMeta={id:'image',scope:'user:a',name:'sample.png',mode:'classic',language:'en',bytes:4,created:1,updated:1,state:'submitting',sha256:'a'.repeat(64),inputBytes:4,mime:'image/png'};
test('old records omit model; explicit choices survive ordinary/retry/regenerate request serialization',()=>{
  assert.ok(!('model_id' in translationBody(record)));
  assert.equal(translationBody({...record,modelId:'a'}).model_id,'a');
  assert.deepEqual(translationBody({...record,modelId:'a',intent:{retry_of:'source'}}),{retry_of:'source',model_id:'a'});
  assert.deepEqual(translationBody({...record,modelId:'b',intent:{regenerate_of:'source'}}),{regenerate_of:'source',model_id:'b'});
});
test('both availability states and upgrade are accessible in every locale',()=>{
  for(const locale of locales){
    assert.ok(Object.values(modelCopy[locale]).every(value=>typeof value==='string'&&value.length>0));
    const html=renderToStaticMarkup(createElement(TranslationModelPicker,{models:[
      {id:'free',name:'Free model',available:true,requires_paid:false},
      {id:'paid',name:'Paid model',available:false,requires_paid:true,unavailable_reason:'not_allowed'},
    ],onChange:()=>{},copy:modelCopy[locale],upgradeUrl:'/pricing/'}));
    assert.match(html,/<a[^>]*href="\/pricing\/"[^>]*><strong>Paid model/);
    assert.ok(!html.includes('class="button secondary"'));
    assert.ok(!html.includes(modelCopy[locale].not_allowed));
    assert.ok(html.includes(modelCopy[locale].unavailable));
    assert.ok(html.includes(modelCopy[locale].free));
    assert.ok(html.includes(modelCopy[locale].paid));
  }
});
test('missing capability supports legacy automatic requests but not stale explicit selections',()=>{
  assert.equal(selectedModelAvailable(undefined),true);assert.equal(selectedModelAvailable([]),false);
  assert.equal(selectedModelAvailable(undefined,'saved'),false);
});
test('dropdown panel uses the existing menu radius separately from its control radius',()=>{
  const css=readFileSync(new URL('../src/styles/translate.css',import.meta.url),'utf8');
  const panel=css.match(/\.translation-model-options\{([^}]+)\}/)![1];
  assert.ok(panel.includes('border-radius:var(--comic-card-radius)'));
  assert.ok(!panel.includes('border-radius:var(--comic-control-radius)'));
});
