import {msg} from '../i18n/runtime';
import { Api } from '../api';
import type { User } from '../types';
import {secureIdentityUrl,tokenLifetime,type Session} from './model';
import {launchLoginWindow} from './auth-window';
import {loginRedirectUrl} from './auth-redirect';
import {requireHostAccess} from '../host-permissions';
import {requestOidcToken} from './token-request';
import {readAuth} from './storage';
export interface AuthConfig { mode: 'development'|'oidc'; dev_auth: boolean; issuer: string; client_id: string; audience: string; authorization_endpoint: string; token_endpoint: string; scopes: string }
interface Pending { state:string; verifier:string; redirect:string; issuer:string; apiBase:string; tokenEndpoint:string; clientId:string; resource?:string; created:number }
const KEY='nc-oidc-pending';
function encode(bytes:Uint8Array) {return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function isOidcCallback() {const query=new URLSearchParams(location.search);return query.has('state')&&(query.has('code')||query.has('error'));}
async function exchange(callback:string,pending:Pending):Promise<Session> {
  const returned=new URL(callback);const expected=new URL(pending.redirect);
  if(returned.origin!==expected.origin||returned.pathname!==expected.pathname||returned.username||returned.password||returned.hash||
    returned.searchParams.getAll('state').length!==1||returned.searchParams.get('state')!==pending.state||
    ['code','error','iss'].some(key=>returned.searchParams.getAll(key).length>1)||
    returned.searchParams.has('code')&&returned.searchParams.has('error')||
    returned.searchParams.has('iss')&&returned.searchParams.get('iss')!==pending.issuer||Date.now()-pending.created>600000)throw Error(msg("登录状态无效或已过期，请重新登录。"));
  sessionStorage.removeItem(KEY);
  if(returned.searchParams.has('error'))throw Error(msg("身份服务未完成登录，请重试。"));
  const code=returned.searchParams.get('code');if(!code)throw Error(msg("身份服务未返回授权码。"));
  const issuedAt=Date.now();
  const response=await requestOidcToken(pending.tokenEndpoint,new URLSearchParams({grant_type:'authorization_code',client_id:pending.clientId,code,redirect_uri:pending.redirect,code_verifier:pending.verifier,...(pending.resource?{resource:pending.resource}:{})}));
  if(!response.ok){
    const failure=await response.json().catch(()=>null);
    // Never display the raw response: providers may echo codes or other secrets.
    if(failure?.error==='invalid_request'&&typeof failure.error_description==='string'&&/origin .+ not allowed for client/.test(failure.error_description))throw Error(msg("登录来源未获身份服务允许，请管理员在 Logto 应用的 Allowed CORS origins 中登记当前网页或插件来源。"));
    if(failure?.error==='invalid_grant')throw Error(msg("登录授权码已失效或校验失败，请重新登录。"));
    throw Error(msg("登录授权码交换失败（HTTP {0}），请重新登录；若仍失败，请联系管理员检查身份服务配置。", {"0": response.status}));
  }
  const tokens=await response.json();if(typeof tokens.access_token!=='string'||!tokens.access_token||tokens.token_type?.toLowerCase()!=='bearer')throw Error(msg("身份服务未返回有效的访问令牌。"));
  if(typeof tokens.refresh_token!=='string'||!tokens.refresh_token)throw Error(msg("身份服务未授予自动续期权限，请重新登录并授权离线访问；若仍失败，请联系管理员检查应用配置。"));
  const lifetime=tokenLifetime(tokens.expires_in,issuedAt);
  // Product API verifies signature, issuer, audience and expiry before trusting identity.
  const result=await new Api(pending.apiBase,tokens.access_token).request<{user:User}>('/v1/me');
  return {id:crypto.randomUUID(),token:tokens.access_token,...lifetime,user:result.user,apiOrigin:new URL(pending.apiBase).origin,credential:{kind:'oidc',refreshToken:tokens.refresh_token,tokenEndpoint:pending.tokenEndpoint,clientId:pending.clientId,resource:pending.resource??''}};
}
export async function finishOidc():Promise<Session|null> {
  if(!isOidcCallback())return null;
  const raw=sessionStorage.getItem(KEY);if(!raw)throw Error(msg("缺少本次登录上下文，请重新登录。"));
  try{return await exchange(location.href,JSON.parse(raw) as Pending);}finally{history.replaceState(null,'',location.pathname+location.hash);}
}
export async function startOidc(config:AuthConfig,apiBase:string):Promise<Session|null> {
  if(config.mode!=='oidc'||!config.client_id||!config.authorization_endpoint||!config.token_endpoint)throw Error(msg("管理员尚未配置正式登录服务。"));
  const authorization=secureIdentityUrl(config.authorization_endpoint);const token=secureIdentityUrl(config.token_endpoint);
  const extension=typeof chrome!=='undefined'&&Boolean(chrome.runtime?.id);
  const redirect=extension?await loginRedirectUrl():(location.origin+location.pathname);
  if(extension)await requireHostAccess([...new Set([authorization.origin+'/*',token.origin+'/*',
    ...typeof chrome.identity?.launchWebAuthFlow!=='function'?[secureIdentityUrl(redirect).origin+'/*']:[]])]);
  const verifier=encode(crypto.getRandomValues(new Uint8Array(48)));const state=encode(crypto.getRandomValues(new Uint8Array(24)));
  const challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  const pending:Pending={state,verifier,redirect,issuer:config.issuer,apiBase,tokenEndpoint:token.href,clientId:config.client_id,resource:config.audience,created:Date.now()};
  sessionStorage.setItem(KEY,JSON.stringify(pending));
  // Reuse the website's IdP session, but an explicit local sign-out still lets
  // the reader choose another account. Consent retains offline_access grants.
  const prompt=(await readAuth()).reason==='signed_out'?'login consent':'consent';
  const scopes=[...new Set(['openid','profile','offline_access',...config.scopes.split(/\s+/).filter(Boolean)])].join(' ');
  authorization.search=new URLSearchParams({response_type:'code',client_id:config.client_id,redirect_uri:redirect,scope:scopes,prompt,state,code_challenge:challenge,code_challenge_method:'S256',...(config.audience?{resource:config.audience,audience:config.audience}:{})}).toString();
  if(extension){
    try {
      const callback=await launchLoginWindow(authorization.href);
      if(!callback)throw Error(msg("登录窗口已关闭。"));
      return await exchange(callback,pending);
    } catch(error) {
      if(error instanceof Error&&/user did not approve|user (?:cancelled|canceled)|window (?:was )?closed/i.test(error.message))throw Error(msg("登录窗口已关闭。"));
      throw error;
    } finally {sessionStorage.removeItem(KEY);}
  }
  location.assign(authorization.href);return null;
}
