import 'fake-indexeddb/auto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {TranslationModelPicker} from '../src/ui/TranslationModelPicker';
import {ReaderTranslationSettings} from '../src/reader/ReaderSettings';
import {defaults} from '../src/types';
import {ApiError} from '../src/api';
import {TranslationCoordinator,translationJob} from '../src/translation/channels/adapters/nodelane/coordinator';
import {makeOperation,operationId} from '../src/translation/channels/adapters/nodelane/operations';
import {readOperation,readPageOperations,saveOperation} from '../src/translation/channels/adapters/nodelane/store';
import {selectedModelAvailable,type TranslationModelChoice} from '../../../shared/translation-models';
import {fixture,originalInput,snapshot,target} from './translation-fixture';

afterEach(()=>vi.restoreAllMocks());
const pickerMarkup=(models:TranslationModelChoice[],value?:string)=>
  renderToStaticMarkup(createElement(TranslationModelPicker,{selection:{value,models,select:async()=>{}}}));

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
    expect(f.submit).toHaveBeenCalledWith(original.requestId,original.request,undefined);
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
    const f=fixture(),page=target(0),core=new TranslationCoordinator({...f.core.options,modelId:'locked',canSubmit:()=>false});
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
  it('shows exact rates in the selection and choices, keeping unavailable models as upgrade links',()=>{
    const markup=pickerMarkup([
      {id:'a',name:'Model A',available:true,requires_paid:false,quota_multiplier:0.0001},
      {id:'b',name:'Model B',available:false,requires_paid:true,quota_multiplier:2.5,unavailable_reason:'not_allowed'},
    ],'a');
    const trigger=markup.split('</button>')[0],upgrade=markup.match(/<a\b[^>]+pricing[^>]*>[\s\S]*?<\/a>/)?.[0];
    expect(trigger).toContain('Model A');expect(trigger).toContain('0.0001×');
    expect(trigger).not.toContain('可用');
    expect(markup.match(/title="额度消耗倍率：0\.0001×"/g)).toHaveLength(2);
    expect(upgrade).toContain('Model B');expect(upgrade).toContain('付费权益');
    expect(upgrade).toContain('不可用');expect(upgrade).toContain('2.5×');
  });
  it('shows no fixed multiplier for automatic selection in the trigger or menu',()=>{
    const markup=pickerMarkup([{id:'a',name:'Model A',available:true,requires_paid:false,quota_multiplier:2.5}]);
    const [trigger,automatic]=markup.split('</button>');
    for(const part of [trigger,automatic]){
      expect(part).toContain('自动选择（默认）');
      expect(part).not.toContain('nc-model-rate');
    }
    expect(markup.match(/class="nc-model-rate"/g)).toHaveLength(1);
  });
  it.each([undefined,null])('defaults missing explicit rates (%s) to 1× in the selection and choices',rate=>{
    for(const value of ['legacy','removed']){
      const markup=pickerMarkup([
        {id:'legacy',name:'Legacy',available:true,requires_paid:false,quota_multiplier:rate as number|undefined},
        {id:'rated',name:'Rated',available:true,requires_paid:false,quota_multiplier:2.5},
      ],value);
      const trigger=markup.split('</button>')[0];
      expect(trigger).toContain('title="额度消耗倍率：1×"');
      expect(trigger).not.toContain('可用');
      expect(markup.match(/title="额度消耗倍率：1×"/g)).toHaveLength(value==='removed'?3:2);
      expect(markup).toContain('title="额度消耗倍率：2.5×"');
    }
  });
  it.each([0,-1,NaN,Infinity,'2'])('hides an invalid API multiplier (%s)',rate=>{
    const markup=pickerMarkup([
      {id:'a',name:'Model A',available:true,requires_paid:false,quota_multiplier:rate as number},
    ],'a');
    expect(markup).not.toContain('nc-model-rate');
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
});
