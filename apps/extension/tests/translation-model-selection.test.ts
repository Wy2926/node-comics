import 'fake-indexeddb/auto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {readFileSync} from 'node:fs';
import {TranslationModelPicker} from '../src/ui/TranslationModelPicker';
import {ReaderTranslationSettings} from '../src/reader/ReaderSettings';
import {defaults} from '../src/types';
import {ApiError} from '../src/api';
import {TranslationCoordinator,translationJob} from '../src/translation/channels/adapters/nodelane/coordinator';
import {makeOperation,operationId} from '../src/translation/channels/adapters/nodelane/operations';
import {readOperation,readPageOperations,saveOperation} from '../src/translation/channels/adapters/nodelane/store';
import {selectedModelAvailable} from '../../../backend/shared/translation-models';
import {fixture,originalInput,snapshot,target} from './translation-fixture';

afterEach(()=>vi.restoreAllMocks());
describe('model selection',()=>{
  it('keeps automatic operation and request identities and separates explicit models',()=>{
    const page=target(0),automatic=makeOperation(page,'scope','en',originalInput(0));
    expect(automatic.request).not.toHaveProperty('model_id');
    expect(automatic.id).toBe(operationId('scope','en',page));
    const a=makeOperation(page,'scope','en',originalInput(0),undefined,'a');
    const b=makeOperation(page,'scope','en',originalInput(0),undefined,'b');
    expect(new Set([automatic.id,a.id,b.id]).size).toBe(3);
    expect(a.image).toEqual(automatic.image);expect(a.request).toHaveProperty('model_id','a');
  });
  it('recovers a lost response with the original UUID and model after a preference change',async()=>{
    const f=fixture(),page=target(0),original=makeOperation(page,f.core.scope,'zh-Hans',originalInput(0),undefined,'a');
    original.state='uncertain';await saveOperation(original);
    const core=new TranslationCoordinator({...f.core.options,modelId:'b'});
    await core.submit([page]);
    expect(f.api.translations).toHaveBeenCalledWith([original.requestId],expect.anything());
    expect(f.submit).toHaveBeenCalledWith(original.requestId,original.request);
    expect(await readOperation(operationId(core.scope,'zh-Hans',page,'b'))).toBeUndefined();
  });
  it('keeps completed results and only changes model on explicit regeneration',async()=>{
    const f=fixture(),page=target(0),original=makeOperation(page,f.core.scope,'zh-Hans',originalInput(0),undefined,'a');
    original.state='accepted';original.result=snapshot(original.requestId,original.request,{state:'succeeded',model:{id:'a',name:'Model A'}});await saveOperation(original);
    vi.mocked(f.api.translations).mockResolvedValue({items:[original.result],missing_ids:[],unchanged:false,etag:'1'});
    const core=new TranslationCoordinator({...f.core.options,modelId:'b'});
    await core.submit([page]);expect(f.submit).not.toHaveBeenCalled();
    await core.manual(page);
    expect(f.submit).toHaveBeenCalledOnce();expect(f.submit.mock.calls[0][1]).toEqual({regenerate_of:original.requestId,model_id:'b'});
    expect(translationJob(original.result,original).model).toEqual({id:'a',name:'Model A'});
    expect(await readPageOperations(core.scope,'book',page.page.id,'classic','zh-Hans')).toHaveLength(2);
  });
  it('does not create locked model tasks but still recovers accepted requests',async()=>{
    const f=fixture(),page=target(0),core=new TranslationCoordinator({...f.core.options,modelId:'locked',modelAvailable:()=>false});
    await core.submit([page]);expect(f.submit).not.toHaveBeenCalled();
    await expect(core.manual(page)).rejects.toThrow('不可用');
    const original=makeOperation(page,core.scope,'zh-Hans',originalInput(0),undefined,'a');original.state='uncertain';await saveOperation(original);
    const result=snapshot(original.requestId,original.request);
    vi.mocked(f.api.translations).mockResolvedValue({items:[result],missing_ids:[],unchanged:false,etag:'1'});
    await core.submit([page]);expect(f.api.translations).toHaveBeenCalled();expect(f.submit).not.toHaveBeenCalled();
  });
  it('distinguishes absent old-center capability from an empty catalog',()=>{
    expect(selectedModelAvailable(undefined)).toBe(true);expect(selectedModelAvailable([])).toBe(false);
    expect(selectedModelAvailable(undefined,'a')).toBe(false);
  });
  it('refreshes the model catalog on rejection without falling back or resubmitting',async()=>{
    const f=fixture(),refresh=vi.fn(async()=>{});
    const core=new TranslationCoordinator({...f.core.options,modelId:'a',onModelRejected:refresh});
    f.submit.mockRejectedValue(new ApiError('not allowed','TRANSLATION_MODEL_NOT_ALLOWED',403));
    await core.submit([target(0)]);await core.submit([target(0)]);
    expect(refresh).toHaveBeenCalledOnce();expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0][1]).toHaveProperty('model_id','a');
    expect(core.records[0].state).toBe('blocked');
  });
  it('uses shared dropdown styling and makes unavailable rows upgrade links, not selections',()=>{
    const markup=renderToStaticMarkup(createElement(TranslationModelPicker,{selection:{models:[
      {id:'a',name:'Model A',available:true,requires_paid:false},
      {id:'b',name:'Model B',available:false,requires_paid:true,unavailable_reason:'not_allowed'},
    ],select:async()=>{}}}));
    expect(markup).toContain('Model A');expect(markup).toContain('Model B');expect(markup).toContain('不可用');
    expect(markup).toMatch(/<a[^>]+pricing[^>]*><strong>Model B/);
    expect(markup).toContain('付费权益');expect(markup).not.toContain('不消耗免费额度');
    expect(markup).not.toContain('当前权益不支持');expect(markup).not.toContain('class="button secondary"');
    expect(markup).toContain('class="nc-select nc-model-trigger"');expect(markup).toContain('class="nc-select-list nc-model-menu"');
    expect(markup).toContain('aria-haspopup="dialog"');
  });
  it('keeps target language in a dropdown even with a short language list',()=>{
    const f=fixture();
    const markup=renderToStaticMarkup(createElement(ReaderTranslationSettings,{settings:defaults,setSettings:()=>{},note:'',caps:{
      languages:[{id:'en',label:'English'},{id:'ja',label:'日本語'}],modes:[],
      limits:{max_bytes:10,max_pixels:10,max_dimension:10,max_translation_ids:32},entitlements:f.rights,
    }}));
    expect(markup).toMatch(/aria-label="翻译目标语言"[^>]*role="combobox"/);
    expect(markup).not.toContain('nc-reader-choices');
  });
  it('anchors the model menu to its trigger width without a larger minimum',()=>{
    const source=readFileSync(new URL('../src/ui/TranslationModelPicker.tsx',import.meta.url),'utf8');
    expect(source).toContain('Math.min(rect.width,viewport.width-16)');
    expect(source).toContain('menuPosition(rect,viewport,rect.width,');
  });
});
