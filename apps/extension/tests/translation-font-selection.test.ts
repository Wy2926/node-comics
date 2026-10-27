import 'fake-indexeddb/auto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {TRANSLATION_FONTS,defaultTranslationFont,translationFontName,translationFontPreview} from '../../../backend/shared/translation-fonts';
import {TranslationFontPicker} from '../src/ui/TranslationFontPicker';
import {Select,SelectOption} from '../src/ui/Select';
import {availableTranslationFonts,effectiveTranslationFont,selectedFontAvailable} from '../src/translation/fonts';
import {ApiError} from '../src/api';
import {TranslationCoordinator,translationJob} from '../src/translation/channels/adapters/nodelane/coordinator';
import {makeOperation,operationId} from '../src/translation/channels/adapters/nodelane/operations';
import {readOperation,readPageOperations,saveOperation} from '../src/translation/channels/adapters/nodelane/store';
import {fixture,job,originalInput,snapshot,target} from './translation-fixture';

afterEach(()=>vi.restoreAllMocks());
const catalog=TRANSLATION_FONTS.map(({id,languages})=>({id,languages}));

describe('translation font selection',()=>{
  it('preserves legacy and model identities when omitted and separates explicit fonts',()=>{
    const page=target(0),automatic=makeOperation(page,'scope','en',originalInput(0));
    expect(automatic.request).not.toHaveProperty('font_id');
    expect(automatic.id).toBe(operationId('scope','en',page));
    const model=makeOperation(page,'scope','en',originalInput(0),undefined,'model-a');
    expect(model.id).toBe(operationId('scope','en',page,'model-a'));
    const first=makeOperation(page,'scope','en',originalInput(0),undefined,'model-a','comic-relief');
    const second=makeOperation(page,'scope','en',originalInput(0),undefined,'model-a','patrick-hand');
    expect(new Set([automatic.id,model.id,first.id,second.id]).size).toBe(4);
    expect(first.request).toHaveProperty('font_id','comic-relief');expect(first.image).toEqual(automatic.image);
  });
  it.each(['patrick-hand',undefined])('recovers the original font and UUID after selecting %s',async fontId=>{
    const f=fixture(),page=target(0),original=makeOperation(page,f.core.scope,'zh-Hans',originalInput(0),undefined,undefined,'lxgw-wenkai-light');
    original.state='uncertain';await saveOperation(original);
    const core=new TranslationCoordinator({...f.core.options,fontId});
    await core.submit([page]);
    expect(f.api.translations).toHaveBeenCalledWith([original.requestId],expect.anything());
    expect(f.submit).toHaveBeenCalledWith(original.requestId,original.request,undefined);
    expect(await readOperation(operationId(core.scope,'zh-Hans',page,undefined,fontId))).toBeUndefined();
    await expect(core.manual(page)).rejects.toThrow('待核实');expect(f.submit).toHaveBeenCalledOnce();
  });
  it('keeps completed images until an explicit regeneration changes the font',async()=>{
    const f=fixture(),page=target(0),original=makeOperation(page,f.core.scope,'zh-Hans',originalInput(0));
    original.state='accepted';original.result=snapshot(original.requestId,original.request,{state:'succeeded',font_id:null});await saveOperation(original);
    const core=new TranslationCoordinator({...f.core.options,fontId:'lxgw-wenkai-light'});
    await core.submit([page]);expect(f.submit).not.toHaveBeenCalled();
    await core.manual(page);
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0][1]).toEqual({regenerate_of:original.requestId,font_id:'lxgw-wenkai-light'});
    expect(await readPageOperations(core.scope,'book',page.page.id,'classic','zh-Hans')).toHaveLength(2);
  });
  it('explicitly selects the language default on regeneration while preserving legacy null receipts',async()=>{
    const f=fixture(),page=target(0),original=makeOperation(page,f.core.scope,'zh-Hans',originalInput(0),undefined,undefined,'lxgw-wenkai');
    original.state='accepted';original.result=snapshot(original.requestId,original.request,{state:'succeeded',font_id:original.fontId});await saveOperation(original);
    const fontId=defaultTranslationFont('zh-Hans')!.id,core=new TranslationCoordinator({...f.core.options,fontId});
    await core.manual(page);
    expect(f.submit.mock.calls[0][1]).toEqual({regenerate_of:original.requestId,font_id:fontId});
    expect(translationJob({...original.result,font_id:null},original).font_id).toBeNull();
    expect(translationJob(original.result,original).font_id).toBe('lxgw-wenkai');
  });
  it.each([true,false])('uses retry_of only when the failed font remains selected: %s',async same=>{
    const f=fixture(),page=target(0),fontId='lxgw-wenkai-light',original=makeOperation(page,f.core.scope,'zh-Hans',originalInput(0),undefined,undefined,fontId);
    original.state='accepted';original.result=snapshot(original.requestId,original.request,{state:'failed',font_id:fontId});await saveOperation(original);
    const core=new TranslationCoordinator({...f.core.options,fontId:same?fontId:undefined});
    await core.manual(page);
    expect(f.submit).toHaveBeenCalledOnce();
    const body=f.submit.mock.calls[0][1];
    if(same)expect(body).toEqual({retry_of:original.requestId,font_id:fontId});
    else{expect(body).toHaveProperty('image');expect(body).not.toHaveProperty('retry_of');expect(body).not.toHaveProperty('font_id');}
  });
  it('blocks unsupported font admission without blocking an existing UUID recovery',async()=>{
    const f=fixture(),page=target(0),core=new TranslationCoordinator({...f.core.options,fontId:'missing',canSubmit:()=>false});
    await core.submit([page]);expect(f.submit).not.toHaveBeenCalled();
    const original=makeOperation(page,core.scope,'zh-Hans',originalInput(0),undefined,undefined,'lxgw-wenkai-light');
    original.state='uncertain';await saveOperation(original);
    vi.mocked(f.api.translations).mockResolvedValue({items:[snapshot(original.requestId,original.request)],missing_ids:[],unchanged:false,etag:'1'});
    await core.submit([page]);expect(f.api.translations).toHaveBeenCalled();expect(f.submit).not.toHaveBeenCalled();
  });
  it('keeps the frozen font identity when retrying a page receipt without its operation record',async()=>{
    const f=fixture(),page=target(0),fontId='lxgw-wenkai-light',oldId=crypto.randomUUID();
    page.page.translationScope=f.core.scope;page.page.jobs=[job(0,{id:oldId,status:'failed',font_id:fontId})];
    const core=new TranslationCoordinator({...f.core.options,fontId});
    await core.manual(page);
    expect(f.submit.mock.calls[0][1]).toEqual({retry_of:oldId,font_id:fontId});
    const record=await readOperation(operationId(core.scope,'zh-Hans',page,undefined,fontId));
    expect(record?.fontId).toBe(fontId);expect(record?.requestId).toBe(f.submit.mock.calls[0][0]);
  });
  it.each([true,false])('omits an unknown legacy retry font and replays its UUID despite a new preference: local record %s',async local=>{
    const f=fixture(),page=target(0),original=makeOperation(page,f.core.scope,'zh-Hans',originalInput(0));
    original.state='accepted';original.result=snapshot(original.requestId,original.request,{state:'failed'});
    page.page.translationScope=f.core.scope;page.page.jobs=[job(0,{id:original.requestId,status:'failed'})];
    const core=new TranslationCoordinator({...f.core.options,fontId:'lxgw-wenkai'});
    const retry=await core['createOperation'](page,()=>true,{retry_of:original.requestId},local?original:undefined);
    expect(retry.request).toEqual({retry_of:original.requestId});expect(retry.fontId).toBeUndefined();
    retry.state='uncertain';await saveOperation(retry);
    const resumed=new TranslationCoordinator({...f.core.options,fontId:'lxgw-wenkai-light'});
    await resumed.submit([page]);
    expect(f.api.translations).toHaveBeenCalledWith([retry.requestId],expect.anything());
    expect(f.submit).toHaveBeenCalledWith(retry.requestId,{retry_of:original.requestId},undefined);
    expect((await readOperation(retry.id))?.requestId).toBe(retry.requestId);
  });
  it('takes a retry font from the frozen snapshot when the legacy local identity omitted it',async()=>{
    const f=fixture(),page=target(0),original=makeOperation(page,f.core.scope,'zh-Hans',originalInput(0));
    original.result=snapshot(original.requestId,original.request,{state:'failed',font_id:'lxgw-wenkai-light'});
    const core=new TranslationCoordinator({...f.core.options,fontId:'lxgw-wenkai'});
    const retry=await core['createOperation'](page,()=>true,{retry_of:original.requestId},original);
    expect(retry.request).toEqual({retry_of:original.requestId,font_id:'lxgw-wenkai-light'});
    expect(retry.fontId).toBe('lxgw-wenkai-light');
  });
  it('refreshes rejected fonts without falling back or automatically resubmitting',async()=>{
    const f=fixture(),refresh=vi.fn(async()=>{}),core=new TranslationCoordinator({...f.core.options,fontId:'lxgw-wenkai-light',onModelRejected:refresh});
    f.submit.mockRejectedValue(new ApiError('font unavailable','TRANSLATION_FONT_UNAVAILABLE',503));
    await core.submit([target(0)]);await core.submit([target(0)]);
    expect(refresh).toHaveBeenCalledOnce();expect(f.submit).toHaveBeenCalledOnce();expect(core.records[0].state).toBe('blocked');
  });
  it('intersects shipped language coverage with the actual service catalog',()=>{
    expect(availableTranslationFonts(undefined,'en')).toEqual([]);
    expect(availableTranslationFonts([{id:'unshipped',languages:['en']}],'en')).toEqual([]);
    expect(selectedFontAvailable(undefined,'en')).toBe(true);
    expect(selectedFontAvailable(undefined,'en','comic-relief')).toBe(false);
    expect(availableTranslationFonts(catalog,'en').map(font=>font.id)).toContain('comic-relief');
    expect(availableTranslationFonts([{id:'gaegu',languages:['ko']}],'ko').map(font=>font.id)).toEqual(['gaegu']);
    expect(selectedFontAvailable(catalog,'ja','patrick-hand')).toBe(false);
    expect(selectedFontAvailable([{id:'gaegu',languages:['en']}],'ko','gaegu')).toBe(false);
  });
  it('resolves missing, empty and stale preferences to each language default within service capabilities',()=>{
    for(const language of new Set(TRANSLATION_FONTS.flatMap(font=>font.languages))){
      for(const stored of [undefined,'','old-font'])expect(effectiveTranslationFont(catalog,language,stored)).toBe(defaultTranslationFont(language)?.id);
      const available=availableTranslationFonts(catalog,language);
      expect(effectiveTranslationFont(catalog,language,available.at(-1)!.id)).toBe(available.at(-1)!.id);
    }
    expect(effectiveTranslationFont([{id:'lxgw-wenkai-light',languages:['ja']}],'ja')).toBe('lxgw-wenkai-light');
    expect(effectiveTranslationFont(undefined,'en','comic-relief')).toBeUndefined();
    expect(effectiveTranslationFont([{id:'unshipped',languages:['en']}],'en')).toBeUndefined();
  });
  it('only offers target-language labels, with no separate preview card or fake loaded face',()=>{
    const markup=renderToStaticMarkup(createElement(TranslationFontPicker,{language:'ko',selection:{fonts:catalog,value:()=>undefined,select:async()=>{}}}));
    expect(markup).toContain(translationFontName(TRANSLATION_FONTS.find(font=>font.id==='gaegu')!,'ko'));expect(markup).not.toContain('Patrick Hand');expect(markup).not.toContain('nc-font-preview');
    const selected=renderToStaticMarkup(createElement(TranslationFontPicker,{language:'ko',selection:{fonts:catalog,value:()=> 'gaegu',select:async()=>{}}}));
    expect(selected).not.toContain('正在加载字体预览');expect(selected).not.toContain('role="status"');expect(selected).not.toContain('nc-font-preview');expect(selected).not.toContain('font-family:');
    expect(selected).not.toContain('data-value=""');expect(selected).not.toContain('保留原字体');
    expect(renderToStaticMarkup(createElement(TranslationFontPicker,{language:'en'}))).toBe('');
  });
  it('preserves option typography and language in both the list and selected label',()=>{
    const markup=renderToStaticMarkup(createElement(Select,{value:'ar',onChange:()=>{}},createElement(SelectOption,{value:'ar',style:{fontFamily:'Test Font',fontWeight:400,fontSynthesis:'none'},lang:'ar',dir:'rtl'},'خط عربي')));
    expect(markup.match(/style="font-family:Test Font;font-weight:400;font-synthesis:none"/g)).toHaveLength(2);
    expect(markup.match(/lang="ar" dir="rtl"/g)).toHaveLength(2);
  });
  it('keeps the font behavior description accessible in translation settings',()=>{
    const markup=renderToStaticMarkup(createElement(TranslationFontPicker,{language:'en',
      selection:{fonts:catalog,value:()=>undefined,select:async()=>{}}}));
    expect(markup).toContain('字体按目标语言提供；更换仅影响新任务，已有译图需手动重新翻译。');
    const note=markup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(note).toBeTruthy();
    expect(markup).toContain(`<p id="${note}" class="nc-muted">`);
    expect(markup).toContain('<span>翻译字体</span>');
    expect(markup).toContain('data-value="comic-relief"');
  });
  it.each(['zh-Hans','ja','ko','ar'])('uses target-language names and hides fonts on legacy services: %s',language=>{
    const font=TRANSLATION_FONTS.find(font=>font.languages.includes(language))!;
    const selected=renderToStaticMarkup(createElement(TranslationFontPicker,{language,selection:{fonts:catalog,value:()=>font.id,select:async()=>{}}}));
    expect(selected).toContain('翻译字体');expect(selected).toContain(font.names[language]);
    expect(translationFontPreview(font.id,language)?.sample).toBe(font.names[language]);
    const unavailable=renderToStaticMarkup(createElement(TranslationFontPicker,{language,selection:{fonts:[],value:()=>font.id,select:async()=>{}}}));
    expect(unavailable).toBe('');
    const stale=renderToStaticMarkup(createElement(TranslationFontPicker,{language,selection:{fonts:catalog,value:()=> 'old-font',select:async()=>{}}}));
    expect(stale).toContain(`data-value="${defaultTranslationFont(language)!.id}"`);expect(stale).not.toContain('old-font');
  });
  it('keeps a shared font resource stable while changing its target-language name',()=>{
    const font=TRANSLATION_FONTS.find(font=>font.languages.includes('zh-Hans')&&font.languages.includes('ja'))!;
    const chinese=translationFontPreview(font.id,'zh-Hans')!,japanese=translationFontPreview(font.id,'ja')!;
    expect(chinese.url).toBe(japanese.url);expect(chinese.family).toBe(japanese.family);
    expect(chinese.sample).toBe(font.names['zh-Hans']);expect(japanese.sample).toBe(font.names.ja);
    expect(chinese.sample).not.toBe(japanese.sample);
  });
});
