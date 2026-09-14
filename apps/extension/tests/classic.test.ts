import {describe,expect,it,vi} from 'vitest';
import {Api} from '../src/api';
import {automaticScope} from '../src/reader/model';

describe('classic mode and budget boundaries',()=>{
  it('invalidates in-flight automatic preparation across mode, language, account, service or copy changes',()=>{
    const original=automaticScope('copy','alice','https://api.example','zh-Hans','classic');
    for(const changed of [
      automaticScope('copy','alice','https://api.example','zh-Hans','redraw'),
      automaticScope('copy','alice','https://api.example','en','classic'),
      automaticScope('copy','bob','https://api.example','zh-Hans','classic'),
      automaticScope('copy','alice','https://other.example','zh-Hans','classic'),
      automaticScope('other','alice','https://api.example','zh-Hans','classic'),
    ])expect(changed).not.toBe(original);
  });
  it('quotes and submits the selected classic mode',async()=>{
    const calls:{url:string;init:RequestInit}[]=[];
    vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});});
    try{
      const api=new Api('https://api.example','test-token');
      await api.quote(['original'],'classic','zh-Hans');
      await api.create('original','classic','zh-Hans','same-operation');
      expect(JSON.parse(calls[0].init.body as string).mode).toBe('classic');
      expect(calls[1].url).toBe('https://api.example/v1/translations/classic');
      expect((calls[1].init.body as FormData).get('target_language')).toBe('zh-Hans');
    }finally{vi.unstubAllGlobals();}
  });
});
