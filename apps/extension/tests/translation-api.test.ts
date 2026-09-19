import {afterEach,describe,it,expect,vi} from 'vitest';
import {Api} from '../src/api';
afterEach(()=>vi.unstubAllGlobals());
describe('plan API responses',()=>{
 it.each([{body:120,header:'60',expected:120},{body:undefined,header:'75',expected:75},{body:undefined,header:'invalid',expected:undefined}])('parses scoped backpressure $expected',async({body,header,expected})=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'PLAN_RATE_LIMITED',scope:'control',message:'稍后重试',retry_after_seconds:body}}),{status:429,headers:{'Retry-After':header}})));
  await expect(new Api('https://api.example').plan({trigger:'reading',session_id:'s',sequence:1,items:[]})).rejects.toMatchObject({status:429,code:'PLAN_RATE_LIMITED',scope:'control',retryAfterSeconds:expected});
 });
 it('preserves complete per-item receipts on minute-limit 429',async()=>{
  const value={policy_revision:'1',items:[{operation_key:'op',disposition:'deferred',code:'IMAGE_RATE_LIMITED',retry_after_seconds:4}],error:{code:'IMAGE_RATE_LIMITED'}};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(value,{status:429})));
  expect(await new Api('https://api.example').plan({trigger:'reading',session_id:'s',sequence:1,items:[]})).toEqual(value);
 });
});
