import {createServer, type RequestListener} from 'node:http';
import {afterEach, expect, it, vi} from 'vitest';
import {createSourceNetworkContext} from '../src/sources/runtime/http';
import {requestOidcToken} from '../src/auth/token-request';
import {login} from '../src/translation/channels/adapters/manga-translator-ui/protocol';
import {Api} from '../src/api';
import {deliveredBytes, deliveredSnapshot} from './overlay-fixture';

vi.mock('../src/sources/runtime/image-headers',()=>({withImageHeaders:async(_url: string,_headers: unknown,_signal: unknown,read:()=>Promise<unknown>)=>read()}));
const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{vi.unstubAllGlobals();for(const close of cleanup.splice(0))await close();});
async function server(handle: RequestListener) {
  const instance=createServer(handle);
  await new Promise<void>(resolve=>instance.listen(0,'127.0.0.1',resolve));
  cleanup.push(()=>new Promise<void>((resolve,reject)=>{instance.close(error=>error?reject(error):resolve());instance.closeAllConnections();}));
  const address=instance.address();
  if(!address||typeof address==='string')throw Error('Missing fixture port');
  return `http://127.0.0.1:${address.port}`;
}
it('follows source GET and POST redirects while preserving 307 request bodies',async()=>{
  vi.stubGlobal('chrome',undefined);
  const received: {method:string|undefined;body:string}[]=[];
  const destination=await server(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;
    received.push({method:request.method,body});
    response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({success:true,token:'fixture-only'}));
  });
  const source=await server((_request,response)=>response.writeHead(307,{Location:destination+'/target'}).end());
  const context=createSourceNetworkContext();
  expect(JSON.parse(await context.request(source+'/catalog'))).toMatchObject({success:true});
  expect(JSON.parse(await context.request(source+'/catalog',{referer:source+'/',form:{page:'2'}}))).toMatchObject({success:true});
  expect(await(await requestOidcToken(source,new URLSearchParams({grant_type:'refresh_token',refresh_token:'fixture-only'}))).json()).toMatchObject({success:true});
  expect(await login(source+'/', 'fixture-user','fixture-password')).toBe('fixture-only');
  expect(received).toEqual([
    {method:'GET',body:''},
    {method:'POST',body:'page=2'},
    {method:'POST',body:'grant_type=refresh_token&refresh_token=fixture-only'},
    {method:'POST',body:JSON.stringify({username:'fixture-user',password:'fixture-password'})},
  ]);
});
it('follows result redirects without forwarding API authorization across origins',async()=>{
  let authorization: string|undefined, initialAuthorization: string|undefined;
  const bytes=new Uint8Array(await deliveredBytes.arrayBuffer());
  const destination=await server((request,response)=>{authorization=request.headers.authorization;response.end(bytes);});
  const source=await server((request,response)=>{
    if(request.url==='/v1/translations/page/result'){
      initialAuthorization=request.headers.authorization;
      response.writeHead(302,{Location:destination+'/image'}).end();
    }else response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(deliveredSnapshot('page')));
  });
  expect(new Uint8Array(await(await new Api(source,'fixture-only').translationImage('page')).arrayBuffer())).toEqual(bytes);
  expect(initialAuthorization).toBe('Bearer fixture-only');expect(authorization).toBeUndefined();
});
it('does not refresh or revoke the API session when a redirected asset returns 401',async()=>{
  const destination=await server((_request,response)=>response.writeHead(401).end());
  let downloads=0;
  const source=await server((request,response)=>{
    if(request.url==='/v1/translations/page/result'){
      downloads++;response.writeHead(302,{Location:destination+'/image'}).end();
    }else response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(deliveredSnapshot('page')));
  });
  const authorization={token:vi.fn(async()=> 'fixture-only'),reject:vi.fn(async()=>{}),current:vi.fn(async()=>{})};
  const api=new Api(source,'',undefined,undefined,authorization);
  await expect(api.translationImage('page')).rejects.toMatchObject({code:'ASSET_DOWNLOAD_FAILED',status:401});
  expect(downloads).toBe(1);expect(authorization.reject).not.toHaveBeenCalled();
  expect(authorization.token.mock.calls).toEqual([[],[]]);
});
