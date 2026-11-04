import {setReaderProgress} from '../apps/extension/tests/reader-progress-driver.mjs';
// Real Chrome identity popup, isolated profile, local TLS/OIDC/API fixtures only.
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'artifacts/login-popup');await mkdir(output,{recursive:true});
const run=await mkdtemp(path.join(output,'run-')),profile=path.join(run,'profile');await mkdir(profile);
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='https://comics.nodelane.net',flows=new Map(),checks=[],pageErrors=[];
let tokenRequests=0,refreshRequests=0,entitlementRequests=0,accountFailure='',phase='bootstrap',context,reader;
const balance=available=>({granted:available,used:0,reserved:0,available,next_expiry_at:null,resets_at:null});
const entitlements=()=>({plan:'free',plan_name:'free',plus_started_at:null,plus_expires_at:null,timezone:'Asia/Shanghai',generated_at:new Date().toISOString(),pending_previous_period_pages:0,image_rate_limit:{limit:10,window_seconds:60},free_quota:balance(30),subscription_quota:{...balance(0),unlimited:false},purchase_quota:balance(0),modes:{}});
execFileSync(process.env.PYTHON||'python',['-c',`import sys,datetime,pathlib
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
p=pathlib.Path(sys.argv[1]);key=rsa.generate_private_key(public_exponent=65537,key_size=2048);name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'comics.nodelane.net')]);now=datetime.datetime.now(datetime.timezone.utc)
cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(days=1)).not_valid_after(now+datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('comics.nodelane.net')]),False).sign(key,hashes.SHA256())
(p/'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));(p/'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))`,profile]);
const json=(response,value,status=200)=>{response.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});response.end(JSON.stringify(value));};
const server=createServer({key:await readFile(path.join(profile,'key.pem')),cert:await readFile(path.join(profile,'cert.pem'))},(request,response)=>{
  void(async()=>{
    const url=new URL(request.url,origin);
    if(request.method==='OPTIONS'){response.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});response.end();return;}
    if(url.pathname.endsWith('/v1/auth/config')){json(response,{mode:'oidc',dev_auth:false,client_id:'fixture',issuer:origin,authorization_endpoint:origin+'/fixture/authorize',token_endpoint:origin+'/fixture/token',audience:origin,scopes:'openid profile'});return;}
    if(url.pathname==='/fixture/authorize'){
      const id=randomUUID();flows.set(id,Object.fromEntries(url.searchParams));
      response.writeHead(302,{Location:'/fixture/login?flow='+id});response.end();return;
    }
    if(url.pathname==='/fixture/login'){
      response.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
      response.end(`<!doctype html><html lang="zh-CN"><title>隔离登录验证</title><style>body{font:16px system-ui;background:#f3f6fc;padding:44px;color:#24324a}main{background:white;padding:28px;border-radius:16px}button{display:block;margin:24px 0;padding:12px}</style><main><h1>登录测试账户</h1><p>本机模拟身份服务，不访问真实账户。</p><form action="/fixture/complete"><input type="hidden" name="flow" value="${url.searchParams.get('flow')}"><button name="result" value="success">完成测试登录</button><button name="result" value="denied">拒绝授权</button></form></main></html>`);return;
    }
    if(url.pathname==='/fixture/complete'){
      const id=url.searchParams.get('flow'),flow=flows.get(id);assert(flow);
      const callback=new URL(flow.redirect_uri);callback.searchParams.set('state',flow.state);
      callback.searchParams.set(url.searchParams.get('result')==='success'?'code':'error',url.searchParams.get('result')==='success'?id:'access_denied');
      response.writeHead(302,{Location:callback.href});response.end();return;
    }
    if(url.pathname==='/fixture/token'){
      let body='';for await(const chunk of request)body+=chunk;const params=new URLSearchParams(body);
      if(params.get('grant_type')==='refresh_token'){
        assert.equal(params.get('refresh_token'),'fixture-refresh');refreshRequests++;
        assert(['refresh-unavailable','revoked'].includes(accountFailure));
        json(response,{error:accountFailure==='revoked'?'invalid_grant':'temporarily_unavailable'},400);return;
      }
      const flow=flows.get(params.get('code'));
      assert(flow);assert.equal(params.get('redirect_uri'),flow.redirect_uri);assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'),flow.code_challenge);
      tokenRequests++;flows.delete(params.get('code'));json(response,{access_token:'fixture-access',refresh_token:'fixture-refresh',token_type:'Bearer',expires_in:3600});return;
    }
    if(url.pathname.endsWith('/v1/me')){assert.equal(request.headers.authorization,'Bearer fixture-access');json(response,{user:{id:'fixture-reader',name:'隔离测试读者',role:'reader'}});return;}
    if(['/v1/capabilities','/v1/me/entitlements'].includes(url.pathname)){
      if(url.pathname==='/v1/me/entitlements'){assert.equal(request.headers.authorization,'Bearer fixture-access');entitlementRequests++;}
      if(request.headers.authorization&&accountFailure){
        const unavailable=accountFailure==='api-unavailable';
        json(response,{error:{code:unavailable?'AUTH_UNAVAILABLE':'TOKEN_INVALID',message:unavailable?'暂时无法验证登录，请稍后重试':'登录已过期，请重新登录'}},unavailable?503:401);return;
      }
      json(response,url.pathname==='/v1/me/entitlements'?entitlements():{result_protocol:'overlay-v1',modes:[],languages:[],limits:{},entitlements:request.headers.authorization?entitlements():null});return;
    }
    json(response,{error:{message:'隔离夹具未提供此接口'}},503);
  })().catch(()=>{if(!response.headersSent)response.writeHead(500);response.end();});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  const extension=path.join(root,'apps/extension/.output/chrome-mv3');
  context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM||chromium.executablePath(),viewport:null,ignoreHTTPSErrors:true,locale:'zh-CN',args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--ignore-certificate-errors','--no-proxy-server',`--host-resolver-rules=MAP comics.nodelane.net 127.0.0.1:${server.address().port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`,'--window-size=1400,1000']});
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  reader=await context.newPage();reader.on('pageerror',error=>pageErrors.push(error.name));
  await reader.goto(new URL('reader.html',worker.url()).href);
  await reader.evaluate(()=>localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'zh-CN',layout:'single'})));await reader.reload();
  await reader.locator('input[type=file]').setInputFiles(path.join(root,'artifacts/import-validation/pages.cbz'));
  await setReaderProgress(reader.getByRole('slider',{name:'阅读进度'}), '2');
  await reader.waitForFunction(()=>document.querySelector('[data-page-index="1"] img.nc-page-image')?.naturalWidth>0);
  await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  await reader.getByRole('button',{name:'我的账户',exact:true}).click();await reader.getByRole('button',{name:'登录账户',exact:true}).click();
  const initial=await reader.evaluate(()=>chrome.windows.getCurrent({populate:true}));
  for(const action of ['close','denied','success']){
    phase=action;
    const opened=context.waitForEvent('page');await reader.getByRole('button',{name:action==='close'?'登录，开启漫译':'重新登录',exact:true}).click();
    const popup=await opened;await popup.getByRole('button',{name:'完成测试登录'}).waitFor();
    await reader.waitForFunction(()=>chrome.windows.getAll().then(windows=>windows.some(window=>window.type==='popup'&&window.width===600&&window.height===760)));
    const windows=await reader.evaluate(()=>chrome.windows.getAll({populate:true})),auth=windows.find(window=>window.type==='popup');
    assert.notEqual(auth.id,initial.id);assert.equal(auth.tabs.length,1);
    assert.deepEqual(windows.find(window=>window.id===initial.id).tabs.map(tab=>tab.id),initial.tabs.map(tab=>tab.id));
    await popup.screenshot({path:path.join(run,'login-window-'+action+'.png')});
    if(action==='close')await reader.evaluate(id=>chrome.windows.remove(id),auth.id);
    else {const closed=popup.waitForEvent('close');await popup.getByRole('button',{name:action==='success'?'完成测试登录':'拒绝授权'}).click();await closed;}
    if(action==='success')await reader.getByText('隔离测试读者',{exact:true}).waitFor();
    else await reader.getByRole('alert').filter({hasText:action==='close'?'登录窗口已关闭':'身份服务未完成登录'}).waitFor();
    assert.equal(await reader.evaluate(()=>sessionStorage.getItem('nc-oidc-pending')),null);
    await reader.screenshot({path:path.join(run,'reader-'+action+'.png')});
    checks.push(action+': native identity popup is 600x760, adds no main-window tab and returns to the reader');
  }
  phase='resume-navigation';
  await reader.getByRole('button',{name:'我的漫画',exact:true}).click();
  phase='resume-card';
  await reader.getByRole('button',{name:'打开漫画 pages',exact:true}).click();
  phase='resume-position';
  await reader.waitForFunction(()=>document.querySelector('input[aria-label="阅读进度"]')?.value==='2');
  await reader.waitForFunction(()=>document.querySelector('[data-page-index="1"] img.nc-page-image')?.naturalWidth>0);
  checks.push('Original comic resumes on page 2 after cancellation, authorization failure and successful login');
  assert.equal(tokenRequests,1);
  await reader.getByRole('button',{name:'返回我的漫画',exact:true}).click();
  await reader.getByRole('button',{name:'我的账户',exact:true}).click();
  for(const failure of ['api-unavailable','refresh-unavailable','revoked']){
    phase=failure;accountFailure=failure;
    await reader.getByRole('button',{name:'退出登录',exact:true}).click();
    await reader.getByRole('button',{name:'登录账户',exact:true}).click();
    const capabilityResponse=reader.waitForResponse(response=>new URL(response.url()).pathname==='/v1/capabilities'&&response.status()===(failure==='api-unavailable'?503:401));
    const opened=context.waitForEvent('page');
    await reader.getByRole('button',{name:'登录，开启漫译',exact:true}).click();
    const popup=await opened,closed=popup.waitForEvent('close');
    await popup.getByRole('button',{name:'完成测试登录'}).click();await closed;await capabilityResponse;
    let auth;
    for(let attempt=0;attempt<100;attempt++){
      auth=await reader.evaluate(()=>chrome.storage.local.get('nc-auth').then(value=>value['nc-auth']));
      if(failure==='api-unavailable'||auth?.reason==='expired'||auth?.session?.retryAt)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if(failure==='revoked'){
      assert.equal(auth.session,null);assert.equal(auth.reason,'expired');
      await reader.locator('.nc-notifications').getByRole('button',{name:'重新登录',exact:true}).waitFor();
      await reader.getByRole('button',{name:'登录账户',exact:true}).waitFor();
      assert.equal(await reader.getByText('正在读取会员权益…',{exact:true}).count(),0);
      checks.push('An explicitly revoked grant still clears the new session and offers sign-in');
    }else{
      assert.equal(auth.session?.user.id,'fixture-reader');assert.equal(auth.reason,undefined);
      await reader.getByText('隔离测试读者',{exact:true}).waitFor();
      assert.equal(await reader.locator('.nc-notifications').getByRole('button',{name:'重新登录',exact:true}).count(),0);
      if(failure==='api-unavailable')assert.equal(refreshRequests,0);
      else {assert(auth.session.retryAt>Date.now());assert.equal(refreshRequests,1);}
      checks.push(failure+': post-login service failure retains the account without a misleading expired-login prompt');
      phase=failure+'-account-load';
      const accountError=reader.getByRole('alert').filter({hasText:'暂时无法读取权益'});
      await accountError.waitFor({timeout:5000});
      assert.equal(await reader.getByText('正在读取会员权益…',{exact:true}).count(),0);
      assert.equal(await reader.getByText('权益读取中',{exact:true}).count(),0);
      await reader.screenshot({path:path.join(run,'account-'+failure+'.png')});
      const refresh=reader.getByRole('button',{name:'刷新权益',exact:true}),beforeRequests=entitlementRequests;
      const failedRefresh=reader.waitForResponse(response=>new URL(response.url()).pathname==='/v1/me/entitlements');
      await refresh.click();await failedRefresh;await accountError.waitFor();
      assert.equal(await refresh.getAttribute('aria-busy'),'false');
      assert.equal(await reader.getByText('正在读取会员权益…',{exact:true}).count(),0);
      assert.equal(entitlementRequests,beforeRequests+1);
      phase=failure+'-account-recovery';accountFailure='';
      await refresh.click();await reader.getByText('免费额度',{exact:true}).waitFor();
      assert.equal(await accountError.count(),0);assert.equal(await refresh.getAttribute('aria-busy'),'false');
      assert.equal(entitlementRequests,beforeRequests+2);
      assert.equal((await reader.evaluate(()=>chrome.storage.local.get('nc-auth').then(value=>value['nc-auth']))).session.id,auth.session.id);
      checks.push(failure+': first-load and retry failures stop loading; one manual retry recovers balances in the same session');
    }
    await reader.screenshot({path:path.join(run,'reader-'+failure+'.png')});
  }
  assert.equal(tokenRequests,4);assert.equal(refreshRequests,2);assert.deepEqual(pageErrors,[]);
  const result={checks,tokenRequests,refreshRequests,entitlementRequests,pageErrors,browser:context.browser()?.version(),nativeIdentity:true,liveIdentityProvider:false};
  await writeFile(path.join(run,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){
  const failure={phase,errorType:error.name};await writeFile(path.join(run,'failure.json'),JSON.stringify(failure));console.error(failure);process.exitCode=1;
  await reader?.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});
}finally{await context?.close();await new Promise(resolve=>server.close(resolve));}
