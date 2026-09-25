import {API_ORIGIN} from '../src/service';
import {defaults} from '../src/types';
import {saveSettings} from '../src/comics/application/preferences';
import {seedReaderFixture} from './reader-fixture-data';
import {readAuth} from '../src/auth/storage';
import {listChannels,selectChannel} from '../src/translation/channels';
import {clearStorage} from '../src/comics/application/source-lifecycle';

if(location.origin!=='http://127.0.0.1:5176')throw Error('Use a fresh profile on the isolated fixture origin.');
await saveSettings({...defaults,uiLanguage:'zh-CN',appearance:'light'});
await seedReaderFixture(API_ORIGIN,'local',()=>{throw Error('Local fixture must not seed official jobs.');});
const originalFetch=window.fetch.bind(window);
const output=await (await originalFetch('/samples/starlight-bookshop.png')).blob();
const state={loginCount:0,requests:[] as {language:string;token:boolean;hasImage:boolean}[],officialTranslations:0,fail:false,
  listChannels,selectChannel,readAuth,clearCache:()=>clearStorage('translations')};
Object.assign(window,{channelFixture:state});
window.fetch=async(input,init={})=>{
  const url=new URL(String(input),location.origin);
  if(url.pathname==='/fixture-mtu/auth/login'){
    state.loginCount++;
    const input=JSON.parse(String(init.body));
    return Response.json(input.username==='fixture'&&input.password==='fixture-pass'?{success:true,token:'synthetic-local-token'}:{success:false});
  }
  if(url.pathname==='/fixture-mtu/translate/with-form/image'){
    const form=init.body as FormData;
    state.requests.push({language:JSON.parse(String(form.get('config'))).translator.target_lang,token:new Headers(init.headers).get('X-Session-Token')==='synthetic-local-token',hasImage:form.get('image') instanceof Blob});
    await new Promise(resolve=>setTimeout(resolve,180));
    if(state.fail)return new Response('synthetic failure',{status:503});
    return new Response(output,{headers:{'Content-Type':'image/png'}});
  }
  if(url.pathname.startsWith('/v1/')){
    if(url.pathname.startsWith('/v1/translations'))state.officialTranslations++;
    return Response.json({error:{message:'Official service is disabled in this signed-out fixture'}},{status:401});
  }
  if(url.origin!==location.origin)throw Error('External traffic blocked in isolated fixture');
  return originalFetch(input,init);
};
await import('../src/main');
