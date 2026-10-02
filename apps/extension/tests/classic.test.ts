import {describe,expect,it,vi} from 'vitest';
import {Api} from '../src/api';
import type {TranslationInput} from '../src/types';
import {translationScope} from '../src/translation/channels/adapters/nodelane/store';
describe('classic-only translation writes',()=>{
 it('scopes requests by account and service',()=>{expect(translationScope('https://a','alice')).not.toBe(translationScope('https://a','bob'));expect(translationScope('https://a','alice')).not.toBe(translationScope('https://b','alice'));});
 it('submits classic without reading metadata',async()=>{
  const mode='classic';
  const fetch=vi.fn(async()=>Response.json({id:'stable-id'}));vi.stubGlobal('fetch',fetch);
  try{await new Api('https://api.example','token').translate('stable-id',{mode,target_language:'zh-Hans',image:{sha256:'a'.repeat(64),byte_size:4,content_type:'image/png'}});expect(fetch).toHaveBeenCalledOnce();const [url,init]=fetch.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('https://api.example/v1/translations/stable-id');expect(init.method).toBe('PUT');expect(JSON.parse(init.body as string)).toEqual({mode,target_language:'zh-Hans',image:{sha256:'a'.repeat(64),byte_size:4,content_type:'image/png'}});}finally{vi.unstubAllGlobals();}
 });
 it('rejects an unknown mode before making a network request',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  try{await expect(new Api('https://api.example','token').translate('invalid-mode-id',{mode:'unsupported',target_language:'en',image:{sha256:'b'.repeat(64),byte_size:4,content_type:'image/png'}} as unknown as TranslationInput)).rejects.toMatchObject({code:'TRANSLATION_MODE_UNAVAILABLE'});expect(fetch).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
 });
 it.each(['retry_of','regenerate_of','input'] as const)('writes classic %s without a preliminary metadata request',async action=>{
  const fetch=vi.fn(async(_url:string,_init:RequestInit)=>Response.json({id:'classic-new',mode:'classic',state:'needs_input'}));vi.stubGlobal('fetch',fetch);
  const api=new Api('https://api.example','classic-'+action),blob=new Blob(['data'],{type:'image/png'});
  try{
   await (action==='input'?api.translationInput('classic-new',blob):api.translate('classic-new',action==='retry_of'?{retry_of:'classic-old'}:{regenerate_of:'classic-old'}));
   expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0][0]).toBe('https://api.example/v1/translations/classic-new'+(action==='input'?'/input':''));
   const init=fetch.mock.calls[0][1];expect(init.method).toBe('PUT');
   if(action==='input')expect(init.body).toBe(blob);
   else expect(JSON.parse(init.body as string)).toEqual({[action]:'classic-old'});
  }finally{vi.unstubAllGlobals();}
 });
});
