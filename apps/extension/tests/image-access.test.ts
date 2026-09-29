import 'fake-indexeddb/auto';
import {afterEach,expect,it,vi} from 'vitest';
import {Api} from '../src/api';
import {deliveredBytes,deliveredSnapshot} from './overlay-fixture';
import {loadDeliveredResult} from '../src/storage/translations/results';
import {translationJob} from '../src/translation/channels/adapters/nodelane/coordinator';
afterEach(()=>vi.unstubAllGlobals());
function setup(path='/v1/translations/page/result',response=new Response(deliveredBytes)){
  const snapshot=deliveredSnapshot('page');snapshot.result!.artifact!.path=path;
  const fetch=vi.fn().mockResolvedValueOnce(Response.json(snapshot)).mockResolvedValueOnce(response);vi.stubGlobal('fetch',fetch);
  return {fetch,api:new Api('https://api.example',crypto.randomUUID())};
}
it('downloads only authenticated same-origin result bytes without an access/signature request',async()=>{
  const {fetch,api}=setup();await api.translationImage('page');
  expect(fetch).toHaveBeenCalledTimes(2);expect(String(fetch.mock.calls[1][0])).toBe('https://api.example/v1/translations/page/result');
  expect(new Headers(fetch.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer '+api.token);
  expect(fetch.mock.calls[1][1]).toMatchObject({credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store'});
});
it.each(['https://external.example/result','//external.example/result','/v1/translations/other/result','/v1/translations/page/result?signature=x'])('rejects an invalid artifact path %s before sending tokens',async path=>{
  const {fetch,api}=setup(path);await expect(api.translationImage('page')).rejects.toMatchObject({code:'INVALID_ASSET_ORIGIN'});expect(fetch).toHaveBeenCalledOnce();
});
it('rejects altered artifact bytes at the shared materialization boundary',async()=>{
  const {api}=setup(undefined,new Response(new Blob(['wrong'],{type:'image/webp'})));
  const job=translationJob(deliveredSnapshot('page'));
  await expect(loadDeliveredResult({scope:{key:crypto.randomUUID()},job,isCurrent:()=>true,download:()=>api.translationImage('page')})).rejects.toMatchObject({code:'RESULT_ARTIFACT_INVALID'});
});
it('keeps a missing file as a read failure without requesting new translation',async()=>{
  const {api,fetch}=setup(undefined,new Response('',{status:404}));await expect(api.translationImage('page')).rejects.toMatchObject({code:'ASSET_DOWNLOAD_FAILED'});expect(fetch).toHaveBeenCalledTimes(2);
});
