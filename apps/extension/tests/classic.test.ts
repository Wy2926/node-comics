import {describe,expect,it,vi} from 'vitest';
import {Api} from '../src/api';
import {translationScope} from '../src/translation/store';

describe('independent mode submission contracts',()=>{
 it('scopes durable manifests by account and service',()=>{expect(translationScope('https://a','alice')).not.toBe(translationScope('https://a','bob'));expect(translationScope('https://a','alice')).not.toBe(translationScope('https://b','alice'));});
 it.each(['classic','redraw'] as const)('submits %s with an explicit finite consent and stable key',async mode=>{
  const calls:{url:string;init:RequestInit}[]=[];
  vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json({});});
  try{await new Api('https://api.example','token').submit({mode,target_language:'zh-Hans',regenerate:false,max_quota_pages:1,items:[{client_item_id:'page',image_sha256:'a'.repeat(64),byte_size:4,content_type:'image/png',name:'1.png'}]},'stable-key');expect(calls[0].url).toBe('https://api.example/v1/translation-submissions');expect(JSON.parse(calls[0].init.body as string)).toMatchObject({mode,max_quota_pages:1});expect(calls[0].init.headers).toMatchObject({'Idempotency-Key':'stable-key'});}finally{vi.unstubAllGlobals();}
 });
});
