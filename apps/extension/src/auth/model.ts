import type {User} from '../types';

export interface Session {
  id:string;
  token:string;
  expiresAt:number;
  refreshAt:number;
  user:User;
  apiOrigin:string;
  credential:{kind:'development'}|{kind:'oidc';refreshToken:string;tokenEndpoint:string;clientId:string;resource:string};
  retryAt?:number;
}
export interface AuthState {session:Session|null;reason?:'expired';}
export const expiredMessage='登录已过期，请重新登录。原图和阅读位置已保留。';
export class SessionExpired extends Error {constructor(){super(expiredMessage);}}
export class RefreshUnavailable extends Error {constructor(){super('暂时无法续期登录，请检查网络后重试。原图仍可继续阅读。');}}
export function secureIdentityUrl(value:string){
  const url=new URL(value);
  if(url.username||url.password||url.protocol!=='https:'&&!(['127.0.0.1','localhost'].includes(url.hostname)&&url.protocol==='http:'))throw Error('身份服务必须使用 HTTPS。');
  return url;
}
export function tokenLifetime(seconds:unknown,issuedAt=Date.now()){
  if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<=0||seconds>31536000)throw Error('身份服务未返回有效的令牌有效期，请重新登录。');
  const duration=seconds*1000;
  return {expiresAt:issuedAt+duration,refreshAt:issuedAt+duration-Math.min(60000,duration/10)};
}
export function validSession(value:unknown):value is Session {
  if(!value||typeof value!=='object')return false;
  const s=value as Session;
  if(typeof s.id!=='string'||!s.id||typeof s.token!=='string'||!s.token||!Number.isFinite(s.expiresAt)||!Number.isFinite(s.refreshAt)||s.refreshAt>=s.expiresAt||!s.user||typeof s.user.id!=='string'||typeof s.user.name!=='string'||typeof s.user.role!=='string')return false;
  if(s.retryAt!==undefined&&!Number.isFinite(s.retryAt))return false;
  if(s.credential?.kind==='development')return true;
  if(s.credential?.kind!=='oidc'||!s.credential.refreshToken||typeof s.credential.refreshToken!=='string'||typeof s.credential.clientId!=='string'||!s.credential.clientId||typeof s.credential.resource!=='string')return false;
  try{secureIdentityUrl(s.credential.tokenEndpoint);return true;}catch{return false;}
}
