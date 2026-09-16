import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Api, ApiError} from '../src/api';
import {emptyPage} from '../src/reader/model';
import {claimFreeReuse} from '../src/translation/free-reuse';

beforeEach(()=>{
  const items=new Map<string,string>();
  vi.stubGlobal('sessionStorage',{getItem:(k:string)=>items.get(k)??null,setItem:(k:string,v:string)=>items.set(k,v),removeItem:(k:string)=>items.delete(k)});
});
afterEach(()=>vi.unstubAllGlobals());
const page=()=>({...emptyPage('sample.png',100,200),fileHash:'a'.repeat(64),pageIndex:0,imageSha256:'b'.repeat(64),imageByteSize:50,imageMime:'image/png'});

it('keeps zero allowance and the finite entitlement snapshot, retaining the key after lost responses',async()=>{
  const api=new Api('https://example.test'),p=page();
  const submit=vi.spyOn(api,'submit').mockRejectedValueOnce(new ApiError('offline')).mockResolvedValueOnce({id:'free',mode:'redraw',target_language:'zh-Hans',items:[{client_item_id:p.id,reused:true,job:{} as never}]});
  await expect(claimFreeReuse(api,'alice',[p],'redraw','zh-Hans','unavailable')).rejects.toThrow('offline');
  await claimFreeReuse(api,'alice',[p],'redraw','zh-Hans','unavailable');
  expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);
  expect(submit.mock.calls[0][0]).toMatchObject({max_quota_pages:0,expected_kind:'unavailable',regenerate:false});
});

it('continues to the next cached page after a definite miss and never probes unlimited classic',async()=>{
  const api=new Api('https://example.test'),first=page(),second={...page(),pageIndex:1};
  const submit=vi.spyOn(api,'submit').mockRejectedValueOnce(new ApiError('no access','PLUS_REQUIRED',403))
    .mockResolvedValueOnce({id:'free',mode:'redraw',target_language:'zh-Hans',items:[{client_item_id:second.id,reused:true,job:{} as never}]});
  await claimFreeReuse(api,'alice',[first,second],'redraw','zh-Hans','unavailable');
  expect(submit).toHaveBeenCalledTimes(2);
  await expect(claimFreeReuse(api,'alice',[first],'classic','zh-Hans','classic_unlimited')).rejects.toThrow('不限量');
  expect(submit).toHaveBeenCalledTimes(2);
});

it('propagates throttling and preserves the request for recovery',async()=>{
  const api=new Api('https://example.test'),p=page();
  const submit=vi.spyOn(api,'submit').mockRejectedValue(new ApiError('slow down','SUBMISSION_DAILY_LIMIT',429));
  await expect(claimFreeReuse(api,'alice',[p],'classic','zh-Hans','classic_daily')).rejects.toThrow('slow down');
  await expect(claimFreeReuse(api,'alice',[p],'classic','zh-Hans','classic_daily')).rejects.toThrow('slow down');
  expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);
});

it('uses local bytes for a freshly imported page with no server metadata',async()=>{
  const api=new Api('https://example.test'),p={...page(),blobKey:'local-image',imageByteSize:undefined,imageMime:undefined};
  const submit=vi.spyOn(api,'submit').mockResolvedValueOnce({id:'free',mode:'redraw',target_language:'zh-Hans',items:[{client_item_id:p.id,reused:true,job:{} as never}]});
  await claimFreeReuse(api,'alice',[p],'redraw','zh-Hans','unavailable',async()=>new Blob(['sample'],{type:'image/png'}));
  expect(submit.mock.calls[0][0].items[0]).toMatchObject({byte_size:6,content_type:'image/png'});
});
