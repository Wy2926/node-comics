import {describe,expect,it,vi} from 'vitest';
import {Api} from '../src/api';
import {translationScope} from '../src/translation/store';
describe('independent translation modes',()=>{
 it('scopes requests by account and service',()=>{expect(translationScope('https://a','alice')).not.toBe(translationScope('https://a','bob'));expect(translationScope('https://a','alice')).not.toBe(translationScope('https://b','alice'));});
 it.each(['classic','redraw'] as const)('submits %s without reading metadata',async mode=>{
  const fetch=vi.fn(async()=>Response.json({id:'stable-id'}));vi.stubGlobal('fetch',fetch);
  try{await new Api('https://api.example','token').translate('stable-id',{mode,target_language:'zh-Hans',image:{sha256:'a'.repeat(64),byte_size:4,content_type:'image/png'}});const [url,init]=fetch.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('https://api.example/v1/translations/stable-id');expect(init.method).toBe('PUT');expect(JSON.parse(init.body as string)).toEqual({mode,target_language:'zh-Hans',image:{sha256:'a'.repeat(64),byte_size:4,content_type:'image/png'}});}finally{vi.unstubAllGlobals();}
 });
});
