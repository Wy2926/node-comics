import {describe,expect,it,vi} from 'vitest';
import {Api} from '../src/api';
import {translationScope} from '../src/translation/store';
describe('independent mode plan contracts',()=>{
 it('scopes operations by account and service',()=>{expect(translationScope('https://a','alice')).not.toBe(translationScope('https://a','bob'));expect(translationScope('https://a','alice')).not.toBe(translationScope('https://b','alice'));});
 it.each(['classic','redraw'] as const)('plans %s with finite consent and a persisted operation key',async mode=>{
  const calls:{url:string;init:RequestInit}[]=[];vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json({});});
  try{await new Api('https://api.example','token').plan({trigger:'reading',session_id:'reader',sequence:1,items:[{page_key:'page',operation_key:'stable-key',role:'current',mode,target_language:'zh-Hans',max_quota_pages:1,image:{client_item_id:'page',image_sha256:'a'.repeat(64),byte_size:4,content_type:'image/png',name:'1.png'}}]});expect(calls[0].url).toBe('https://api.example/v1/translation-plans');expect(JSON.parse(calls[0].init.body as string).items[0]).toMatchObject({mode,max_quota_pages:1,operation_key:'stable-key'});}finally{vi.unstubAllGlobals();}
 });
});
