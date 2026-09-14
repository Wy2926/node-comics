import { Api } from '../api';
import type { User } from '../types';
export interface AuthConfig { mode: 'development'|'oidc'; dev_auth: boolean; issuer: string; client_id: string; audience: string; authorization_endpoint: string; token_endpoint: string; scopes: string }
interface Pending { state:string; verifier:string; redirect:string; apiBase:string; tokenEndpoint:string; clientId:string; resource?:string; created:number }
export interface OidcSession { token:string; user:User; apiOrigin:string }
const KEY='nc-oidc-pending';
function encode(bytes:Uint8Array) {return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function secureUrl(value:string) {const url=new URL(value);if(url.protocol!=='https:'&&!(['127.0.0.1','localhost'].includes(url.hostname)&&url.protocol==='http:'))throw Error('身份服务必须使用 HTTPS。');return url;}
export function isOidcCallback() {const query=new URLSearchParams(location.search);return query.has('state')&&(query.has('code')||query.has('error'));}
async function exchange(callback:string,pending:Pending):Promise<OidcSession> {
  const returned=new URL(callback);const expected=new URL(pending.redirect);
  if(returned.origin!==expected.origin||returned.pathname!==expected.pathname||returned.searchParams.get('state')!==pending.state||Date.now()-pending.created>600000)throw Error('登录状态无效或已过期，请重新登录。');
  sessionStorage.removeItem(KEY);
  if(returned.searchParams.has('error'))throw Error('身份服务未完成登录，请重试。');
  const code=returned.searchParams.get('code');if(!code)throw Error('身份服务未返回授权码。');
  const response=await fetch(pending.tokenEndpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:pending.clientId,code,redirect_uri:pending.redirect,code_verifier:pending.verifier,...(pending.resource?{resource:pending.resource}:{})})});
  if(!response.ok)throw Error('登录授权码交换失败，请重新登录。');
  const tokens=await response.json();if(typeof tokens.access_token!=='string')throw Error('身份服务未返回访问令牌。');
  // Product API verifies signature, issuer, audience and expiry before trusting identity.
  const result=await new Api(pending.apiBase,tokens.access_token).request<{user:User}>('/v1/me');
  return {token:tokens.access_token,user:result.user,apiOrigin:new URL(pending.apiBase).origin};
}
export async function finishOidc():Promise<OidcSession|null> {
  if(!isOidcCallback())return null;
  const raw=sessionStorage.getItem(KEY);if(!raw)throw Error('缺少本次登录上下文，请重新登录。');
  try{return await exchange(location.href,JSON.parse(raw) as Pending);}finally{history.replaceState(null,'',location.pathname+location.hash);}
}
export async function startOidc(config:AuthConfig,apiBase:string):Promise<OidcSession|null> {
  if(config.mode!=='oidc'||!config.client_id||!config.authorization_endpoint||!config.token_endpoint)throw Error('管理员尚未配置正式登录服务。');
  const authorization=secureUrl(config.authorization_endpoint);const token=secureUrl(config.token_endpoint);
  const extension=typeof chrome!=='undefined'&&Boolean(chrome.identity?.launchWebAuthFlow);
  if(extension){const granted=await chrome.permissions.request({origins:[...new Set([authorization.origin+'/*',token.origin+'/*'])]});if(!granted)throw Error('需要身份服务的访问权限才能完成登录。');}
  const verifier=encode(crypto.getRandomValues(new Uint8Array(48)));const state=encode(crypto.getRandomValues(new Uint8Array(24)));
  const challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  const redirect=extension?chrome.identity.getRedirectURL('oidc'):(location.origin+location.pathname);
  const pending:Pending={state,verifier,redirect,apiBase,tokenEndpoint:token.href,clientId:config.client_id,resource:config.audience,created:Date.now()};
  sessionStorage.setItem(KEY,JSON.stringify(pending));
  authorization.search=new URLSearchParams({response_type:'code',client_id:config.client_id,redirect_uri:redirect,scope:config.scopes||'openid profile',state,code_challenge:challenge,code_challenge_method:'S256',...(config.audience?{resource:config.audience,audience:config.audience}:{})}).toString();
  if(extension){const callback=await chrome.identity.launchWebAuthFlow({url:authorization.href,interactive:true});if(!callback)throw Error('登录窗口已关闭。');return exchange(callback,pending);}
  location.assign(authorization.href);return null;
}
