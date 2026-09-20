import {StaleOperation} from '../concurrency';
import {readAuth,updateSession} from './storage';
import {RefreshUnavailable,SessionExpired,tokenLifetime,type Session} from './model';

export interface Authorization {
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
  await updateSession(session.id,session.token,()=>({session:null,reason:'expired'}));
  throw new SessionExpired();
}
export function sessionAuthorization(id:string):Authorization{
  return {
    current:async()=>{await currentSession(id);},
    reject:async token=>{const session=await currentSession(id);if(session.token===token)await expire(session);throw new SessionExpired();},
    token:async rejectedToken=>await navigator.locks.request('nc-auth-refresh:'+id,async()=>{
      const session=await currentSession(id);
      const rejected=rejectedToken===session.token;
      if(!rejected&&session.refreshAt>Date.now())return session.token;
      if(session.credential.kind==='development'){
        if(rejected||session.expiresAt<=Date.now())return expire(session);
        return session.token;
      }
      if(session.retryAt&&session.retryAt>Date.now()){
        if(!rejected&&session.expiresAt>Date.now())return session.token;
        throw new RefreshUnavailable();
      }
      const credential=session.credential;
      let response:Response;
      const issuedAt=Date.now();
      try{
        response=await fetch(credential.tokenEndpoint,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:credential.refreshToken,client_id:credential.clientId,...(credential.resource?{resource:credential.resource}:{})})});
      }catch{return unavailable(session,rejected);}
      // Logout/account switch can complete while the refresh is on the network.
      await currentSession(id);
      if(response.status===429||response.status>=500)return unavailable(session,rejected);
      if(!response.ok)return expire(session);
      let next:Session;
      try{
        const tokens=await response.json();
        if(typeof tokens.access_token!=='string'||!tokens.access_token||tokens.token_type?.toLowerCase()!=='bearer'||tokens.refresh_token!==undefined&&(typeof tokens.refresh_token!=='string'||!tokens.refresh_token))return expire(session);
        next={...session,token:tokens.access_token,...tokenLifetime(tokens.expires_in,issuedAt),retryAt:undefined,credential:{...credential,refreshToken:tokens.refresh_token??credential.refreshToken}};
      }catch{return expire(session);}
      if(!await updateSession(id,session.token,()=>({session:next})))throw new StaleOperation();
      return next.token;
    }),
  };
}
async function unavailable(session:Session,rejected:boolean){
  await currentSession(session.id);
  await updateSession(session.id,session.token,s=>({session:{...s,retryAt:Date.now()+30000}}));
  if(!rejected&&session.expiresAt>Date.now())return session.token;
  throw new RefreshUnavailable();
}
