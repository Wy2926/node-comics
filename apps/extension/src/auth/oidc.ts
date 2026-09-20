import {msg} from '../i18n/runtime';
import { Api } from '../api';
import type { User } from '../types';
import {secureIdentityUrl,tokenLifetime,type Session} from './model';
export interface AuthConfig { mode: 'development'|'oidc'; dev_auth: boolean; issuer: string; client_id: string; audience: string; authorization_endpoint: string; token_endpoint: string; scopes: string }
interface Pending { state:string; verifier:string; redirect:string; apiBase:string; tokenEndpoint:string; clientId:string; resource?:string; created:number }
const KEY='nc-oidc-pending';
function encode(bytes:Uint8Array) {return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function isOidcCallback() {const query=new URLSearchParams(location.search);return query.has('state')&&(query.has('code')||query.has('error'));}
async function exchange(callback:string,pending:Pending):Promise<Session> {
  const returned=new URL(callback);const expected=new URL(pending.redirect);
  if(returned.origin!==expected.origin||returned.pathname!==expected.pathname||returned.searchParams.get('state')!==pending.state||Date.now()-pending.created>600000)throw Error(msg("登录状态无效或已过期，请重新登录。"));
  sessionStorage.removeItem(KEY);
  if(returned.searchParams.has('error'))throw Error(msg("身份服务未完成登录，请重试。"));
  const code=returned.searchParams.get('code');if(!code)throw Error(msg("身份服务未返回授权码。"));
  const issuedAt=Date.now();
  const response=await fetch(pending.tokenEndpoint,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:pending.clientId,code,redirect_uri:pending.redirect,code_verifier:pending.verifier,...(pending.resource?{resource:pending.resource}:{})})});
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
  const extension=typeof chrome!=='undefined'&&Boolean(chrome.identity?.launchWebAuthFlow);
  if(extension){const permissions={origins:[...new Set([authorization.origin+'/*',token.origin+'/*'])]};const granted=await chrome.permissions.contains(permissions)||await chrome.permissions.request(permissions);if(!granted)throw Error(msg("需要身份服务的访问权限才能完成登录。"));}
  const verifier=encode(crypto.getRandomValues(new Uint8Array(48)));const state=encode(crypto.getRandomValues(new Uint8Array(24)));
  const challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  const redirect=extension?chrome.identity.getRedirectURL('oidc'):(location.origin+location.pathname);
  const pending:Pending={state,verifier,redirect,apiBase,tokenEndpoint:token.href,clientId:config.client_id,resource:config.audience,created:Date.now()};
  sessionStorage.setItem(KEY,JSON.stringify(pending));
  // Local sign-out leaves the identity provider's SSO cookie intact. Explicit
  // sign-in must let the reader enter another account instead of reusing it.
  const scopes=[...new Set(['openid','profile','offline_access',...config.scopes.split(/\s+/).filter(Boolean)])].join(' ');
  authorization.search=new URLSearchParams({response_type:'code',client_id:config.client_id,redirect_uri:redirect,scope:scopes,prompt:'login consent',state,code_challenge:challenge,code_challenge_method:'S256',...(config.audience?{resource:config.audience,audience:config.audience}:{})}).toString();
  if(extension){const callback=await chrome.identity.launchWebAuthFlow({url:authorization.href,interactive:true});if(!callback)throw Error(msg("登录窗口已关闭。"));return exchange(callback,pending);}
  location.assign(authorization.href);return null;
}
