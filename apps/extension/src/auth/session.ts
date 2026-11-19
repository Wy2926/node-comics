import {StaleOperation} from '../concurrency';
import {readAuth,updateSession} from './storage';
import {RefreshUnavailable,SessionExpired,tokenLifetime,type Session} from './model';
import {requestOidcToken} from './token-request';
import {ApiError} from '../api-error';

export interface Authorization {
  readonly cacheKey?:string;
  token(rejectedToken?:string):Promise<string>;
  reject(token:string):Promise<void>;
  current():Promise<void>;
}
async function currentSession(id:string){
  const {session}=await readAuth();
  if(!session)throw new SessionExpired();
  if(session.id!==id)throw new StaleOperation();
  return session;
}
async function expire(session:Session):Promise<never>{
  if(!await updateSession(session.id,session.token,()=>({session:null,reason:'expired'})))throw new StaleOperation();
  throw new SessionExpired();
}
export function sessionAuthorization(id:string):Authorization{
  return {
    cacheKey:id,
    current:async()=>{await currentSession(id);},
    reject:async token=>{const session=await currentSession(id);if(session.token!==token)throw new StaleOperation();await expire(session);},
    token:async rejectedToken=>await navigator.locks.request('nc-auth-refresh:'+id,async()=>{
      const session=await currentSession(id);
      const rejected=session.accessRejected===true||rejectedToken===session.token;
      if(!rejected&&session.refreshAt>Date.now())return session.token;
      if(session.credential.kind==='development'){
        if(rejected||session.expiresAt<=Date.now())return expire(session);
        return session.token;
      }
      if(session.retryAt&&session.retryAt>Date.now()){
        if(!rejected&&session.expiresAt>Date.now())return session.token;
        if(rejected&&!session.accessRejected)await updateSession(id,session.token,s=>({session:{...s,accessRejected:true}}));
        throw new RefreshUnavailable(session.retryReason);
      }
      const credential=session.credential;
      let response:Response;
      const issuedAt=Date.now();
      try{
        response=await requestOidcToken(credential.tokenEndpoint,new URLSearchParams({grant_type:'refresh_token',refresh_token:credential.refreshToken,client_id:credential.clientId,...(credential.resource?{resource:credential.resource}:{})}));
      }catch(error){return unavailable(session,rejected,error instanceof ApiError&&error.code==='NETWORK_ERROR'?'network':'service');}
      // Logout/account switch can complete while the refresh is on the network.
      await currentSession(id);
      if(response.status===429||response.status>=500)return unavailable(session,rejected,response.status===429?'limited':'service');
      if(!response.ok){
        const failure=await response.json().catch(()=>null);
        // Only an explicit grant rejection invalidates the account. Proxy,
        // client configuration and other transport errors are not revocation.
        if(['invalid_grant','login_required','interaction_required','consent_required','account_selection_required'].includes(failure?.error))return expire(session);
        return unavailable(session,rejected,['invalid_client','unauthorized_client','invalid_scope','invalid_target','invalid_request'].includes(failure?.error)?'configuration':'service');
      }
      let next:Session;
      try{
        const tokens=await response.json();
        if(typeof tokens.access_token!=='string'||!tokens.access_token||tokens.token_type?.toLowerCase()!=='bearer'||tokens.refresh_token!==undefined&&(typeof tokens.refresh_token!=='string'||!tokens.refresh_token))return unavailable(session,rejected,'response');
        next={...session,token:tokens.access_token,...tokenLifetime(tokens.expires_in,issuedAt),retryAt:undefined,retryReason:undefined,accessRejected:undefined,credential:{...credential,refreshToken:tokens.refresh_token??credential.refreshToken}};
      }catch{return unavailable(session,rejected,'response');}
      if(!await updateSession(id,session.token,()=>({session:next})))throw new StaleOperation();
      return next.token;
    }),
  };
}
async function unavailable(session:Session,rejected:boolean,reason:RefreshUnavailable['reason']){
  if(!await updateSession(session.id,session.token,s=>({session:{...s,retryAt:Date.now()+30000,retryReason:reason,accessRejected:rejected}})))throw new StaleOperation();
  if(!rejected&&session.expiresAt>Date.now())return session.token;
  throw new RefreshUnavailable(reason);
}
